import * as Lark from "@larksuiteoapi/node-sdk"
import { isSelfMentioned, type FeishuBotIdentity, type FeishuMention } from "./feishu-mention"
import type { PlatformAdapter, MessageHandler, MessageContext, ParsedMessage, SenderInfo } from "./platform"

// ── Feishu types (private) ──────────────────────────────────────────
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
  mentions?: FeishuMention[]
}

type FeishuEventPayload = {
  event?: { sender?: FeishuSender; message?: FeishuMessage }
  sender?: FeishuSender
  message?: FeishuMessage
}

type FeishuBotInfoResponse = {
  code?: unknown
  bot?: unknown
}

// ── Message parsing (private) ───────────────────────────────────────
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

// ── Adapter factory ────────────────────────────────────────────────
export async function createFeishuAdapter(): Promise<PlatformAdapter> {
  const appId = process.env.FEISHU_APP_ID?.trim() || ""
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() || ""

  if (!appId || !appSecret) {
    throw new Error("Missing required env: FEISHU_APP_ID and/or FEISHU_APP_SECRET")
  }

  const client = new Lark.Client({ appId, appSecret })
  const configuredBotIdentity: FeishuBotIdentity = {
    openId: process.env.FEISHU_BOT_OPEN_ID?.trim() || undefined,
  }
  const resolvedBotIdentity = await resolveBotIdentity(client, configuredBotIdentity)

  const adapter: PlatformAdapter = {
    name: "feishu",

    listen(handler: MessageHandler): void {
      const eventDispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data: unknown) => {
          handleFeishuMessage(data, handler)
        },
      })

      const wsClient = new Lark.WSClient({ appId, appSecret })
      console.log(`[feishu] starting WS client`)
      void wsClient.start({ eventDispatcher })
    },

    async reply(messageId: string, text: string): Promise<void> {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
        },
      })
    },

    async fetchMessage(messageId: string): Promise<string | null> {
      try {
        const resp = await client.im.message.get({ path: { message_id: messageId } })
        const item = resp?.data?.items?.[0]
        if (!item?.msg_type || !item?.body?.content) return null
        return parseMessageContent(item.body.content, item.msg_type)
      } catch (err) {
        console.warn(`[feishu] fetch message ${messageId} failed: ${String(err)}`)
        return null
      }
    },
  }

  return adapter

  // ── Event handler (hoisted; closure over adapter) ──────────────
  function handleFeishuMessage(data: unknown, handler: MessageHandler): void {
    console.log(`[feishu] message event received`)
    const payload = data as FeishuEventPayload
    const sender = payload.sender ?? payload.event?.sender
    const message = payload.message ?? payload.event?.message

    if (!message?.message_id || !message.chat_id) {
      console.log(`[feishu] skipped: no message_id or chat_id`)
      return
    }

    if (sender?.sender_type && ["app", "bot", "app_bot"].includes(sender.sender_type.toLowerCase())) {
      console.log(`[feishu] skipped: sender_type=${sender.sender_type}`)
      return
    }

    if (message.chat_type === "group") {
      const botMentioned = isSelfMentioned(message.mentions, resolvedBotIdentity)
      if (!botMentioned) {
        console.log(`[feishu] skipped no-self-mention in group: ${message.message_id}`)
        return
      }
    }

    const text = normalizeMentions(parseMessageContent(message.content, message.message_type), message.mentions)
    if (!text) {
      console.log(`[feishu] skipped: empty text after parse`)
      return
    }

    const senderId =
      sender?.sender_id?.open_id || sender?.sender_id?.user_id || sender?.sender_id?.union_id || "unknown"

    const parsedMessage: ParsedMessage = {
      messageId: message.message_id!,
      chatId: message.chat_id!,
      text,
      isGroup: message.chat_type === "group",
      timestamp: message.create_time ? parseInt(message.create_time, 10) : 0,
    }

    const senderInfo: SenderInfo = {
      userId: `Feishu:${senderId}`,
    }

    void (async () => {
      try {
        let parentText: string | undefined
        if (message.parent_id) {
          parentText = (await adapter.fetchMessage(message.parent_id)) ?? undefined
        }

        const ctx: MessageContext = {
          message: parsedMessage,
          sender: senderInfo,
          parentText,
          platform: "feishu",
        }

        await handler(ctx)
      } catch (err) {
        console.error(`[feishu] handler error:`, err)
      }
    })()
  }
}

export async function resolveBotIdentity(
  client: Pick<Lark.Client, "request">,
  configuredIdentity: FeishuBotIdentity,
): Promise<FeishuBotIdentity> {
  let discoveredIdentity: FeishuBotIdentity | undefined

  try {
    const resp = await client.request<FeishuBotInfoResponse>({
      method: "GET",
      url: "open-apis/bot/v3/info",
      timeout: 10_000,
    })
    discoveredIdentity = parseBotIdentityResponse(resp)
  } catch (err) {
    if (!hasStableBotIdentity(configuredIdentity)) {
      throw new Error(
        "Failed to resolve Feishu bot identity; configure FEISHU_BOT_OPEN_ID as a fallback",
        { cause: err },
      )
    }
    console.warn("[feishu] bot identity API lookup failed; using configured stable identity")
    return { ...configuredIdentity }
  }

  if (configuredIdentity.openId && configuredIdentity.openId !== discoveredIdentity.openId) {
    throw new Error("Configured FEISHU_BOT_OPEN_ID does not match the authenticated Feishu app")
  }

  const identity: FeishuBotIdentity = {
    ...configuredIdentity,
    openId: discoveredIdentity.openId,
    name: discoveredIdentity.name,
  }
  console.log(`[feishu] bot identity resolved${identity.name ? `: ${identity.name}` : ""}`)
  return identity
}

function parseBotIdentityResponse(resp: FeishuBotInfoResponse): FeishuBotIdentity {
  if (typeof resp.code !== "number") {
    throw new Error("Feishu bot identity API returned an invalid response")
  }
  if (resp.code !== 0) {
    throw new Error(`Feishu bot identity API returned code=${resp.code}`)
  }
  if (!resp.bot || typeof resp.bot !== "object") {
    throw new Error("Feishu bot identity API response is missing bot data")
  }

  const bot = resp.bot as Record<string, unknown>
  const openId = typeof bot.open_id === "string" ? bot.open_id.trim() : ""
  if (!openId) {
    throw new Error("Feishu bot identity API response is missing bot open_id")
  }

  return {
    openId,
    name: typeof bot.app_name === "string" ? bot.app_name.trim() || undefined : undefined,
  }
}

function hasStableBotIdentity(identity: FeishuBotIdentity): boolean {
  return Boolean(identity.openId)
}
