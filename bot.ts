#!/usr/bin/env bun
import * as Lark from "@larksuiteoapi/node-sdk"
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import os from "node:os"

const DEFAULT_TARGET_REPO = "owner/repo"
const DEFAULT_RCM_BIN = "accelerate"
const DEFAULT_REPO_PATH = "./repo"

const rootDir = path.dirname(new URL(import.meta.url).pathname)
const rcmDir = path.join(rootDir, "rcm-synergy")
const cacheDir = path.join(rcmDir, ".rcm-cache")

const config = {
  appId: process.env.FEISHU_APP_ID?.trim() || "",
  appSecret: process.env.FEISHU_APP_SECRET?.trim() || "",
  rcmBin: process.env.RCM_BIN || DEFAULT_RCM_BIN,
  repoPath: process.env.REPO_PATH || DEFAULT_REPO_PATH,
  targetRepo: process.env.TARGET_REPO || DEFAULT_TARGET_REPO,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  ghPathPrefix: process.env.GH_PATH_PREFIX || "gh",
  maxRunSeconds: Number(process.env.RCM_RUN_TIMEOUT_SECONDS || "420"),
}

// Dedup: Feishu WS delivers at-least-once + resend on reconnect.
// 1) In-memory message_id dedup (5min) for within-session duplicates
// 2) Time gate: only process messages created within 10s of now (filters replay/retry)
const recentMessageIds = new Set<string>()
function isDuplicateMessage(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) return true
  recentMessageIds.add(messageId)
  setTimeout(() => recentMessageIds.delete(messageId), 5 * 60_000)
  return false
}

type FeishuSender = {
  sender_id?: { open_id?: string; user_id?: string; union_id?: string }
  sender_type?: string
}

type FeishuMessage = {
  message_id?: string
  chat_id?: string
  chat_type?: string
  message_type?: string
  content?: string
  create_time?: string
  root_id?: string
  parent_id?: string
  mentions?: Array<{ key: string; name?: string; id?: { open_id?: string }; mentioned_type?: string }>
}

// WSClient passes event.content directly (no outer "event" wrapper)
type FeishuEventPayload = {
  event?: { sender?: FeishuSender; message?: FeishuMessage }
  sender?: FeishuSender
  message?: FeishuMessage
}

function requireFeishuCredentials() {
  if (!config.appId) throw new Error("Missing required env: FEISHU_APP_ID")
  if (!config.appSecret) throw new Error("Missing required env: FEISHU_APP_SECRET")
}

function parseMessageContent(content: string | undefined, messageType: string | undefined): string {
  if (!content) return ""
  if (messageType === "image") return "[Image]"
  if (messageType === "file") return "[File]"
  if (messageType === "audio") return "[Audio]"
  if (messageType === "video") return "[Video]"
  if (messageType === "sticker") return "[Sticker]"

  try {
    const parsed = JSON.parse(content)
    if (messageType === "text") return parsed.text || ""
    if (messageType === "post") return parsePostText(parsed)
  } catch {
    return content
  }
  return content
}

function parsePostText(parsed: Record<string, unknown>): string {
  const content = findPostContent(parsed)
  const lines: string[] = []
  for (const paragraph of content) {
    if (!Array.isArray(paragraph)) continue
    const parts: string[] = []
    for (const item of paragraph) {
      if (!item || typeof item !== "object") continue
      const el = item as { tag?: string; text?: string; href?: string; image_key?: string }
      if (el.tag === "text" && el.text) parts.push(el.text)
      if (el.tag === "a" && el.text) parts.push(el.href ? `${el.text}(${el.href})` : el.text)
      if (el.tag === "img") parts.push("[Image]")
    }
    if (parts.length > 0) lines.push(parts.join(""))
  }
  return lines.join("\n")
}

function findPostContent(parsed: Record<string, unknown>): unknown[] {
  if (Array.isArray(parsed.content)) return parsed.content
  for (const value of Object.values(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const inner = value as Record<string, unknown>
    if (Array.isArray(inner.content)) return inner.content
  }
  return []
}

function normalizeMentions(text: string, mentions: Array<{ key: string; name?: string }> | undefined): string {
  let result = text
  for (const mention of mentions ?? []) {
    result = result.split(mention.key).join(`@${mention.name || "user"}`)
  }
  return result.trim()
}

function runRcm(input: { sessionId: string; reporter: string; message: string; source: string }): string {
  // Sanitize message for RCM template safety: remove newlines, escape quotes, limit length
  const safeMessage = input.message
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
  mkdirSync(cacheDir, { recursive: true })
  const eventPath = path.join(os.tmpdir(), `synergy_feishu_issue_${input.sessionId}.json`)
  writeFileSync(
    eventPath,
    JSON.stringify(
      {
        session_id: input.sessionId,
        reporter: input.reporter,
        message: safeMessage,
        source: input.source,
        target_repo: config.targetRepo,
        repo_path: config.repoPath,
      },
      null,
      2,
    ),
  )

  try {
    const dispatch = spawnSync(
      config.rcmBin,
      [
        "dispatch",
        "--config",
        path.join(rcmDir, "dispatch.toml"),
        "--event-name",
        "issue_triage",
        "--action",
        "feishu_message",
        "--event-path",
        eventPath,
      ],
      { cwd: rcmDir, encoding: "utf8", timeout: 15_000 },
    )
    if (dispatch.status !== 0) {
      throw new Error(`dispatch failed: ${(dispatch.stderr || dispatch.stdout).trim().slice(0, 800)}`)
    }

    const rcmPath = extractRcmPath(dispatch.stdout)
    if (!rcmPath) throw new Error(`dispatch returned no .rcm path: ${dispatch.stdout.trim().slice(0, 800)}`)

    const run = spawnSync(config.rcmBin, ["run", rcmPath, "--speed", "0"], {
      cwd: rcmDir,
      encoding: "utf8",
      timeout: config.maxRunSeconds * 1000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: config.deepseekApiKey,
        PATH: `${config.ghPathPrefix}:${process.env.PATH || ""}`,
      },
    })
    const debugPath = path.join(cacheDir, `${path.basename(rcmPath)}.run.log`)
    writeFileSync(
      debugPath,
      JSON.stringify(
        {
          rcmPath,
          status: run.status,
          signal: run.signal,
          stdout: run.stdout,
          stderr: run.stderr,
        },
        null,
        2,
      ),
    )

    if (run.status !== 0) {
      throw new Error(`run failed for ${rcmPath}; debug log: ${debugPath}; ${(run.stderr || run.stdout).trim().slice(0, 1200)}`)
    }

    return extractRcmReply(run.stdout, debugPath)
  } finally {
    rmSync(eventPath, { force: true })
  }
}

function extractRcmPath(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.reverse().find((line) => line.endsWith(".rcm"))
}

function extractRcmReply(output: string, debugPath: string): string {
  let reply = ""
  let inResponse = false
  for (const line of output.trim().split("\n")) {
    if (line.includes("╭─ Response")) {
      inResponse = true
      continue
    }
    if (inResponse && line.includes("╰")) {
      inResponse = false
      continue
    }
    if (inResponse) {
      const stripped = line.trim()
      if (stripped) reply = stripped
    }
  }
  if (reply) return reply
  const trimmed = output.trim()
  if (trimmed) return trimmed.slice(-1000)
  throw new Error(`RCM produced empty stdout; debug log: ${debugPath}`)
}

async function replyMessage(messageId: string, text: string) {
  requireFeishuCredentials()
  const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret })
  await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  })
}

async function fetchMessageContent(messageId: string): Promise<string> {
  try {
    requireFeishuCredentials()
    const client = new Lark.Client({ appId: config.appId, appSecret: config.appSecret })
    const resp = await client.im.message.get({ path: { message_id: messageId } })
    const item = resp?.data?.items?.[0]
    if (!item?.msg_type || !item?.body?.content) return ""
    return parseMessageContent(item.body.content, item.msg_type)
  } catch (err) {
    console.warn(`[bot] fetch parent message ${messageId} failed: ${String(err)}`)
    return ""
  }
}

function handleFeishuMessage(data: unknown) {
  console.log(`[bot] handleFeishuMessage called`, JSON.stringify(data).slice(0, 500))
  const payload = data as FeishuEventPayload
  // WSClient passes sender/message directly; webhook wraps in "event"
  const sender = payload.sender ?? payload.event?.sender
  const message = payload.message ?? payload.event?.message
  console.log(`[bot] sender=`, JSON.stringify(sender).slice(0, 300))
  console.log(`[bot] message=`, JSON.stringify(message).slice(0, 300))

  if (!message?.message_id || !message.chat_id) {
    console.log(`[bot] skipped: no message_id or chat_id`)
    return
  }
  if (sender?.sender_type && ["app", "bot", "app_bot"].includes(sender.sender_type.toLowerCase())) {
    console.log(`[bot] skipped: sender_type=${sender.sender_type}`)
    return
  }

  // Dedup: Feishu WS delivers same event at-least-once
  if (isDuplicateMessage(message.message_id)) {
    console.log(`[bot] skipped duplicate: ${message.message_id}`)
    return
  }

  // Time gate: only process messages created within 10s of now
  const msgCreateTime = message.create_time ? parseInt(message.create_time, 10) : 0
  const now = Date.now()
  if (msgCreateTime > 0 && (now - msgCreateTime > 10_000 || msgCreateTime > now + 5_000)) {
    console.log(`[bot] skipped stale/future: ${message.message_id} create_time=${msgCreateTime} now=${now} diff=${now - msgCreateTime}ms`)
    return
  }

  // Group chat: only respond when bot is @mentioned
  if (message.chat_type === "group") {
    const botMentioned = message.mentions?.some(m => m.mentioned_type === "bot")
    if (!botMentioned) {
      console.log(`[bot] skipped no-bot-mention in group: ${message.message_id}`)
      return
    }
  }

  const text = normalizeMentions(parseMessageContent(message.content, message.message_type), message.mentions)
  if (!text) {
    console.log(`[bot] skipped: empty text after parse`)
    return
  }

  const senderId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || sender?.sender_id?.union_id || "unknown"
  const reporter = `Feishu:${senderId}`
  const source = `${message.chat_type || "unknown"}:${message.chat_id}; message:${message.message_id}`
  const sessionId = `feishu_${message.message_id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || Date.now()}`

  console.log(`[bot] received ${message.message_id}: ${text.slice(0, 120)}`)

  void (async () => {
    try {
      // Fetch quoted message content if present
      let fullMessage = text
      if (message.parent_id) {
        const quoted = await fetchMessageContent(message.parent_id)
        if (quoted) {
          fullMessage = `[回复: ${quoted}]\n${text}`
          console.log(`[bot] quoted parent ${message.parent_id}: ${quoted.slice(0, 100)}`)
        }
      }

      const reply = runRcm({ sessionId, reporter, message: fullMessage, source })
      console.log(`[bot] RCM reply: ${reply}`)
      await replyMessage(message.message_id!, reply)
      console.log(`[bot] reply sent`)
    } catch (err) {
      console.error(`[bot] processing failed:`, err)
      await replyMessage(message.message_id!, "⚠️ 处理失败，请稍后再试或联系 yzx 查看日志。").catch(() => {})
    }
  })()
}

function startListen() {
  requireFeishuCredentials()
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: unknown) => {
      handleFeishuMessage(data)
    },
  })

  const wsClient = new Lark.WSClient({ appId: config.appId, appSecret: config.appSecret })
  console.log(`[bot] starting Feishu WS for repo ${config.targetRepo}`)
  void wsClient.start({ eventDispatcher })
}

function runOnce(message: string) {
  const reply = runRcm({
    sessionId: `manual_${Date.now()}`,
    reporter: "manual-test",
    message,
    source: "manual-once",
  })
  console.log(reply)
}

const [command, ...args] = process.argv.slice(2)
if (command === "listen") {
  startListen()
} else if (command === "once") {
  const message = args.join(" ").trim()
  if (!message) throw new Error('Usage: bun run bot.ts once "message"')
  runOnce(message)
} else {
  console.log("Usage:")
  console.log("  bun run bot.ts listen")
  console.log('  bun run bot.ts once "message"')
}
