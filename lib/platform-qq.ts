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
    setCORSHeaders(res)

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
      case "/qq/pending-replies":
        return handlePendingReplies(req, res)
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

  function handlePendingReplies(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      writeJSON(res, 405, { error: "method not allowed" })
      return
    }

    expireStaleReplies()

    const snapshot: Record<string, string> = {}
    for (const [key, reply] of pendingReplies) {
      snapshot[key] = reply.text
    }
    pendingReplies.clear()

    writeJSON(res, 200, snapshot)
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
      } catch (err) {
        writeJSON(res, 400, { error: `invalid JSON: ${String(err)}` })
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
      server.listen(port, () => {
        console.log(`[qq] HTTP adapter listening on port ${port}`)
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

function setCORSHeaders(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

function writeJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}
