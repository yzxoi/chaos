import { createServer, IncomingMessage, ServerResponse } from "http"
import { parse } from "url"
import type { PlatformAdapter, MessageHandler, MessageContext, ParsedMessage, SenderInfo } from "./platform"

// ── Constants ───────────────────────────────────────────────────────
const FIVE_MINUTES_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 1024 * 1024 // 1 MB

// ── Types ───────────────────────────────────────────────────────────
interface QQMessagePayload {
  message_id: string
  chat_id: string
  sender_id: string
  sender_name: string
  text: string
  is_group: boolean
  timestamp: number
  parent_text: string | null
  parent_id: string | null
}

interface StoredReply {
  text: string
  timestamp: number
}

// ── Adapter Factory ────────────────────────────────────────────────
export function createQQAdapter(port: number = 18080): PlatformAdapter {
  const pendingReplies = new Map<string, StoredReply>()
  let messageHandler: MessageHandler | null = null

  const server = createServer()

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    const parsedUrl = parse(req.url || "/", true)
    const pathname = parsedUrl.pathname || ""

    switch (pathname) {
      case "/qq/health":
        return handleHealth(res)
      case "/qq/pending-replies": {
        const messageId = typeof parsedUrl.query.message_id === "string" ? parsedUrl.query.message_id : undefined
        return handlePendingReplies(req, res, messageId)
      }
      case "/qq/message":
        return handleIncomingMessage(req, res)
      default:
        writeJSON(res, 404, { error: "not found" })
    }
  })

  // ── Route handlers ──────────────────────────────────────────────

  function handleHealth(res: ServerResponse): void {
    writeJSON(res, 200, { status: "ok" })
  }

  function handlePendingReplies(req: IncomingMessage, res: ServerResponse, messageId?: string): void {
    if (req.method !== "GET") {
      writeJSON(res, 405, { error: "method not allowed" })
      return
    }

    expireStaleReplies()

    if (messageId) {
      const reply = pendingReplies.get(messageId)
      if (!reply) {
        writeJSON(res, 200, {})
        return
      }
      pendingReplies.delete(messageId)
      writeJSON(res, 200, { [messageId]: reply.text })
      return
    }
    writeJSON(res, 400, { error: "message_id is required" })
  }

  function handleIncomingMessage(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") {
      writeJSON(res, 405, { error: "method not allowed" })
      return
    }

    let body = ""
    let bodyBytes = 0

    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.length
      if (bodyBytes > MAX_BODY_BYTES) {
        writeJSON(res, 413, { error: "payload too large" })
        req.destroy()
        return
      }
      body += chunk.toString()
    })

    req.on("end", () => {
      if (!body) {
        writeJSON(res, 400, { error: "empty body" })
        return
      }

      let payload: QQMessagePayload
      try {
        payload = JSON.parse(body)
      } catch {
        writeJSON(res, 400, { error: "invalid JSON body" })
        return
      }

      if (!payload.message_id || !payload.chat_id) {
        writeJSON(res, 400, { error: "message_id and chat_id are required" })
        return
      }

      if (!messageHandler) {
        writeJSON(res, 503, { error: "adapter not listening yet" })
        return
      }

      const parsedMessage: ParsedMessage = {
        messageId: payload.message_id,
        chatId: payload.chat_id,
        text: payload.text || "",
        isGroup: payload.is_group,
        timestamp: payload.timestamp || Date.now(),
      }

      const senderInfo: SenderInfo = {
        userId: payload.sender_id,
        userName: payload.sender_name || undefined,
      }

      const ctx: MessageContext = {
        message: parsedMessage,
        sender: senderInfo,
        parentText: payload.parent_text || undefined,
        platform: "qq",
      }

      writeJSON(res, 200, { status: "accepted" })

      // Fire-and-forget: handler may be async
      void (async () => {
        try {
          await messageHandler!(ctx)
        } catch (err) {
          console.error(`[qq] handler error:`, err)
        }
      })()
    })
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function expireStaleReplies(): void {
    const now = Date.now()
    for (const [key, reply] of pendingReplies) {
      if (now - reply.timestamp >= FIVE_MINUTES_MS) {
        pendingReplies.delete(key)
      }
    }
  }

  // ── Public adapter interface ─────────────────────────────────────

  const adapter: PlatformAdapter = {
    name: "qq",

    listen(handler: MessageHandler): void {
      messageHandler = handler
      server.listen(port, "127.0.0.1", () => {
        console.log(`[qq] HTTP adapter listening on 127.0.0.1:${port}`)
      })
    },

    async reply(messageId: string, text: string): Promise<void> {
      pendingReplies.set(messageId, { text, timestamp: Date.now() })
    },

    async fetchMessage(_messageId: string): Promise<string | null> {
      return null
    },

    shutdown(): Promise<void> {
      pendingReplies.clear()
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
    },
  }

  return adapter
}

// ── Module-level helpers ──────────────────────────────────────────


function writeJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}
