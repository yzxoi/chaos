#!/usr/bin/env python3
"""
Chaos QQ Bridge — AstrBot Star plugin

Thin forwarder:
  QQ message → AstrBot → POST /qq/message → Chaos → poll /qq/pending-replies → QQ reply
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid

import urllib.request
import urllib.error
import urllib.parse

from astrbot.api.event import filter, AstrMessageEvent
from astrbot.api.star import Context, Star
from astrbot.api import logger
from astrbot.api.message_components import Plain, Reply

# ── Config ─────────────────────────────────────────────────────────

CHAOS_URL = "http://127.0.0.1:18080"
POLL_INTERVAL = 2  # seconds
POLL_TIMEOUT = max(1, int(os.getenv("CHAOS_POLL_TIMEOUT_SECONDS", "480")))


# ── Plugin ─────────────────────────────────────────────────────────


class ChaosQQBridgePlugin(Star):
    def __init__(self, context: Context):
        super().__init__(context)
        logger.info("Chaos QQ bridge plugin loaded (poll timeout: %ss)", POLL_TIMEOUT)

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_message(self, event: AstrMessageEvent):
        """Forward incoming messages to Chaos and poll for replies."""
        message_str = event.message_str.strip()
        if not message_str:
            return

        # --- Decide whether to handle this message ---
        is_at = False
        bot_self_id = event.get_self_id() or ""
        if event.message_obj and event.message_obj.message:
            for comp in event.message_obj.message:
                if (
                    getattr(comp, "type", None) == "At"
                    or comp.__class__.__name__ == "At"
                ):
                    at_qq = getattr(comp, "qq", None)
                    if at_qq and bot_self_id:
                        is_at = str(at_qq) == str(bot_self_id)
                    else:
                        is_at = True
                    if is_at:
                        break

        # In group chats, only respond when @bot
        if not event.is_private_chat() and not is_at:
            return

        # Strip @-mention markup
        if is_at:
            message_str = re.sub(r"<at[^>]*>|\[CQ:at[^\]]*\]", "", message_str).strip()

        if not message_str:
            return

        # --- Extract reply context from Reply component ---
        parent_text: str | None = None
        if event.message_obj and event.message_obj.message:
            for comp in event.message_obj.message:
                if isinstance(comp, Reply):
                    text = getattr(comp, "text", None)
                    if text:
                        parent_text = text
                    break

        # --- Build payload ---
        msg_obj = event.message_obj
        message_id = getattr(msg_obj, "message_id", None) if msg_obj else None
        if not message_id:
            message_id = f"qq-msg-{uuid.uuid4().hex[:12]}"

        chat_id = getattr(event, "unified_msg_origin", None)
        if not chat_id:
            # Fallback: construct a chat_id from context
            sender_id = event.get_sender_id() or "unknown"
            chat_id = (
                f"qq-group-{sender_id}"
                if not event.is_private_chat()
                else f"qq-user-{sender_id}"
            )

        timestamp_ms = int(time.time() * 1000)
        sender_id = event.get_sender_id() or "unknown"
        sender_name = event.get_sender_name() or ""

        payload = {
            "message_id": message_id,
            "chat_id": chat_id,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "text": message_str,
            "is_group": not event.is_private_chat(),
            "timestamp": timestamp_ms,
            "parent_text": parent_text,
            "parent_id": None,
        }

        logger.info("→ Chaos: [%s] %s: %s", chat_id, sender_name, message_str[:60])

        # --- Forward to Chaos ---
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, _post_message, payload)
        except Exception as e:
            logger.error("Failed to forward message to Chaos: %s", e)
            yield event.chain_result([Plain("⚠️ 连接处理服务失败，请稍后再试。")])
            return

        # --- Poll for reply ---
        t0 = time.time()
        reply_text: str | None = None

        while time.time() - t0 < POLL_TIMEOUT:
            await asyncio.sleep(POLL_INTERVAL)
            try:
                reply_text = await loop.run_in_executor(None, _poll_reply, message_id)
                if reply_text is not None:
                    break
            except Exception as e:
                logger.warning("Poll replies error: %s", e)

        if reply_text:
            logger.info("← Chaos reply: %s", reply_text[:100])
            yield event.chain_result([Plain(reply_text)])
        else:
            logger.info("← Chaos reply timeout for %s", message_id)
            yield event.chain_result([Plain("处理超时，请稍后再试")])

    async def terminate(self):
        logger.info("Chaos QQ bridge plugin terminated")


# ── HTTP helpers (stdlib; runs in executor for async compatibility) ─


def _post_message(payload: dict) -> None:
    """POST payload to Chaos /qq/message."""
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{CHAOS_URL}/qq/message",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        resp.read()  # drain


def _poll_reply(message_id: str) -> str | None:
    """Claim only this message's pending reply without consuming others."""
    query = urllib.parse.urlencode({"message_id": message_id})
    req = urllib.request.Request(
        f"{CHAOS_URL}/qq/pending-replies?{query}", method="GET"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8")
        replies = json.loads(body)
        value = replies.get(message_id)
        return value if isinstance(value, str) else None
