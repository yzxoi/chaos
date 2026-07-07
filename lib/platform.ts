// ── Platform Adapter Interface ──────────────────────────────────────────────
// Each chat platform (Feishu, QQ, DingTalk, etc.) implements this interface.
// The orchestrator (bot.ts) is completely platform-agnostic.

export interface ParsedMessage {
  /** Unique message ID from the platform */
  messageId: string
  /** Unique chat/session ID from the platform */
  chatId: string
  /** Normalized plain text content (mentions stripped, post parsed, media replaced) */
  text: string
  /** Whether this is a group chat */
  isGroup: boolean
  /** Platform timestamp in milliseconds */
  timestamp: number
}

export interface SenderInfo {
  /** Platform-specific user identifier */
  userId: string
  /** Display name (if available) */
  userName?: string
}

export interface MessageContext {
  /** The parsed and normalized message */
  message: ParsedMessage
  /** Sender information */
  sender: SenderInfo
  /** Optional parent message content (for quoted replies) */
  parentText?: string
  /** Platform identifier (e.g. "feishu", "qq") */
  platform: PlatformAdapter["name"]
}

export type MessageHandler = (ctx: MessageContext) => void | Promise<void>

export interface PlatformAdapter {
  /** Short platform identifier: "feishu" | "qq" | "dingtalk" | ... */
  readonly name: string

  /**
   * Start listening for incoming messages.
   * Called once at startup. Must not block — it should call handler
   * asynchronously for each incoming message.
   */
  listen(handler: MessageHandler): void

  /**
   * Reply to a message on this platform.
   */
  reply(messageId: string, text: string): Promise<void>

  /**
   * Fetch the content of a parent/root message (for quote replies).
   * Return null if not supported or not available.
   */
  fetchMessage(messageId: string): Promise<string | null>

  /**
   * Clean up and disconnect. Called on shutdown.
   */
  shutdown?(): void | Promise<void>
}
