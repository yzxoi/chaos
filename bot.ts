#!/usr/bin/env bun
import * as Lark from "@larksuiteoapi/node-sdk"
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

import {
  rootDir,
  rcmDir,
  memoryDir,
  archiveDir,
  botConfig,
  MEMORY_INDEX_MAX_LINES,
  RECENT_CONTEXT_MAX_ROUNDS,
} from "./lib/config"
import {
  safeSlug,
  ensureMemoryLayout,
  chatArchiveDir,
  ensureRecentContext,
  updateRecentContext,
  writeArchiveEntry,
  inferAction,
  chunkText,
  loadImportSource,
  writeImportChunks,
  runMempalaceMine,
} from "./lib/memory"
import { runRcmDispatch } from "./lib/dispatch"

// ── Ingest queue (single-concurrent) ──────────────────────────────
let ingestQueue: Promise<void> = Promise.resolve()

function enqueueIngest(fn: () => Promise<void>): void {
  ingestQueue = ingestQueue.then(fn, fn) // continue even if previous failed
}

// ── Dedup ──────────────────────────────────────────────────────────
const recentMessageIds = new Set<string>()

function isDuplicateMessage(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) return true
  recentMessageIds.add(messageId)
  setTimeout(() => recentMessageIds.delete(messageId), 5 * 60_000)
  return false
}

// ── Feishu types ──────────────────────────────────────────────────
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

type FeishuEventPayload = {
  event?: { sender?: FeishuSender; message?: FeishuMessage }
  sender?: FeishuSender
  message?: FeishuMessage
}

// ── Credentials ───────────────────────────────────────────────────
function requireFeishuCredentials() {
  if (!botConfig.appId) throw new Error("Missing required env: FEISHU_APP_ID")
  if (!botConfig.appSecret) throw new Error("Missing required env: FEISHU_APP_SECRET")
}

// ── Message parsing ───────────────────────────────────────────────
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

// ── Sanitize message for template safety ──────────────────────────
function sanitizeMessage(msg: string): string {
  return msg
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000)
}

// ── RCM dispatch wrappers ────────────────────────────────────────
function runAssistant(input: {
  sessionId: string
  reporter: string
  message: string
  source: string
  chatId: string
  messageId: string
}): { reply: string } {
  const safeMessage = sanitizeMessage(input.message)
  const slugChatId = safeSlug(input.chatId)
  const recentContextPath = ensureRecentContext(slugChatId)
  ensureMemoryLayout()

  const fields: Record<string, string> = {
    session_id: input.sessionId,
    reporter: input.reporter,
    message: safeMessage,
    source: input.source,
    target_repo: botConfig.targetRepo,
    repo_path: botConfig.repoPath,
    memory_dir: memoryDir,
    archive_dir: archiveDir,
    recent_context_path: recentContextPath,
    chat_id: slugChatId,
    message_id: safeSlug(input.messageId, 64),
  }

  const result = runRcmDispatch("assistant", fields)

  return { reply: result.reply }
}

function runMemoryIngest(input: {
  sessionId: string
  reporter: string
  message: string
  reply: string
  action: string
  source: string
}): Promise<void> {
  return new Promise((resolve) => {
    try {
      const fields: Record<string, string> = {
        session_id: input.sessionId,
        reporter: input.reporter,
        message: sanitizeMessage(input.message),
        reply: input.reply,
        action: input.action,
        source: input.source,
        memory_dir: memoryDir,
      }

      runRcmDispatch("memory_ingest", fields, { cwd: memoryDir })
      resolve()
    } catch (err) {
      console.warn(`[ingest] failed:`, String(err))
      resolve() // never reject — non-blocking
    }
  })
}

function runMemoryConsolidate(): string {
  const fields: Record<string, string> = {
    session_id: `consolidate_${Date.now()}`,
    memory_dir: memoryDir,
    target_repo: botConfig.targetRepo,
  }

  const result = runRcmDispatch("memory_consolidate", fields, { cwd: memoryDir })

  return result.reply
}

// ── Feishu reply ──────────────────────────────────────────────────
async function replyMessage(messageId: string, text: string) {
  requireFeishuCredentials()
  const client = new Lark.Client({ appId: botConfig.appId, appSecret: botConfig.appSecret })
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
    const client = new Lark.Client({ appId: botConfig.appId, appSecret: botConfig.appSecret })
    const resp = await client.im.message.get({ path: { message_id: messageId } })
    const item = resp?.data?.items?.[0]
    if (!item?.msg_type || !item?.body?.content) return ""
    return parseMessageContent(item.body.content, item.msg_type)
  } catch (err) {
    console.warn(`[bot] fetch parent message ${messageId} failed: ${String(err)}`)
    return ""
  }
}

// ── Message handler ───────────────────────────────────────────────
function handleFeishuMessage(data: unknown) {
  console.log(`[bot] handleFeishuMessage called`, JSON.stringify(data).slice(0, 500))
  const payload = data as FeishuEventPayload
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
  if (isDuplicateMessage(message.message_id)) {
    console.log(`[bot] skipped duplicate: ${message.message_id}`)
    return
  }

  const msgCreateTime = message.create_time ? parseInt(message.create_time, 10) : 0
  const now = Date.now()
  if (msgCreateTime > 0 && (now - msgCreateTime > 10_000 || msgCreateTime > now + 5_000)) {
    console.log(`[bot] skipped stale/future: ${message.message_id} create_time=${msgCreateTime} now=${now} diff=${now - msgCreateTime}ms`)
    return
  }

  if (message.chat_type === "group") {
    const botMentioned = message.mentions?.some((m) => m.mentioned_type === "bot")
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
  const chatId = message.chat_id!
  const messageId = message.message_id!
  const source = `${message.chat_type || "unknown"}:${chatId}; message:${messageId}`
  const sessionId = `feishu_${messageId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || Date.now()}`

  console.log(`[bot] received ${messageId}: ${text.slice(0, 120)}`)

  void (async () => {
    try {
      let fullMessage = text
      if (message.parent_id) {
        const quoted = await fetchMessageContent(message.parent_id)
        if (quoted) {
          fullMessage = `[回复: ${quoted}]\n${text}`
          console.log(`[bot] quoted parent ${message.parent_id}: ${quoted.slice(0, 100)}`)
        }
      }

      // Ensure recent context file exists before calling RCM
      const slugChatId = safeSlug(chatId)
      const recentContextPath = ensureRecentContext(slugChatId)

      const { reply } = runAssistant({
        sessionId,
        reporter,
        message: fullMessage,
        source,
        chatId,
        messageId,
      })
      console.log(`[bot] reply: ${reply}`)

      await replyMessage(messageId, reply)
      console.log(`[bot] reply sent`)

      // Layer A: archive after successful reply
      const action = inferAction(reply)
      writeArchiveEntry(chatId, messageId, reporter, action, fullMessage, reply)

      // Update recent context
      updateRecentContext(slugChatId, {
        time: new Date().toISOString(),
        messageId,
        reporter,
        q: fullMessage,
        a: reply,
        action,
      })

      // Mempalace mine chat archive (fire-and-forget)
      runMempalaceMine(chatArchiveDir(slugChatId), slugChatId)

      // Layer B: enqueue ingest (async, single-concurrent)
      enqueueIngest(async () => {
        try {
          await runMemoryIngest({
            sessionId,
            reporter,
            message: fullMessage,
            reply,
            action,
            source,
          })
          // Check MEMORY.md line count
          const memIndexPath = path.join(memoryDir, "MEMORY.md")
          if (existsSync(memIndexPath)) {
            const lineCount = readFileSync(memIndexPath, "utf8").split("\n").length
            if (lineCount > MEMORY_INDEX_MAX_LINES) {
              console.warn(`[memory] MEMORY.md has ${lineCount} lines (> ${MEMORY_INDEX_MAX_LINES}); run 'bun run bot.ts consolidate'`)
            }
          }
        } catch (err) {
          console.warn(`[ingest] queue task failed:`, String(err))
        }
      })
    } catch (err) {
      console.error(`[bot] processing failed:`, err)
      await replyMessage(messageId, "⚠️ 处理失败，请稍后再试或联系 yzx 查看日志。").catch(() => {})
    }
  })()
}

// ── Listen ────────────────────────────────────────────────────────
function startListen() {
  requireFeishuCredentials()
  ensureMemoryLayout()
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: unknown) => {
      handleFeishuMessage(data)
    },
  })

  const wsClient = new Lark.WSClient({ appId: botConfig.appId, appSecret: botConfig.appSecret })
  console.log(`[bot] starting Feishu WS for repo ${botConfig.targetRepo}`)
  void wsClient.start({ eventDispatcher })
}

// ── Once ──────────────────────────────────────────────────────────
function runOnce(message: string) {
  const sessionId = `manual_${Date.now()}`
  const { reply } = runAssistant({
    sessionId,
    reporter: "manual-test",
    message,
    source: "manual-once",
    chatId: "manual",
    messageId: `manual_${Date.now()}`,
  })
  console.log(reply)
}

// ── Import ────────────────────────────────────────────────────────
async function runImport(inputArg: string, distill: boolean): Promise<void> {
  try {
    const { text, sourceSlug } = await loadImportSource(inputArg)
    const chunks = chunkText(text)

    if (chunks.length === 0) {
      console.log(`import: source produced no chunks after splitting`)
      process.exit(1)
    }

    // Write archive
    const { paths, archiveDir: importArchiveDir } = writeImportChunks(sourceSlug, chunks, inputArg, distill)
    console.log(`import: ${chunks.length} chunks written to ${importArchiveDir}`)

    // Mempalace mine import dir
    const mempalaceWing = `imports-${sourceSlug}`
    await runMempalaceMine(importArchiveDir, mempalaceWing)

    // Distill
    let remembered = 0
    let updated = 0
    let skipped = 0
    if (distill) {
      for (let i = 0; i < chunks.length; i++) {
        await new Promise<void>((resolve) => {
          enqueueIngest(async () => {
            try {
              await runMemoryIngest({
                sessionId: `import_${sourceSlug}_${i}`,
                reporter: "import",
                message: chunks[i],
                reply: "",
                action: "imported",
                source: `import:${inputArg}`,
              })
              remembered++
            } catch {
              skipped++
            }
            resolve()
          })
          // Wait for this chunk's ingest to complete before moving to next
        })
      }
      // Wait for queue to drain
      await ingestQueue
    }

    // Summary
    console.log(`--- Import Summary ---`)
    console.log(`Source: ${inputArg}`)
    console.log(`Source slug: ${sourceSlug}`)
    console.log(`Chunks: ${chunks.length}`)
    console.log(`Archive: ${importArchiveDir}`)
    console.log(`Distill: ${distill ? `yes (remembered=${remembered}, skipped=${skipped})` : "no"}`)
    console.log(`Mempalace: ${mempalaceWing}`)
  } catch (err) {
    console.error(`import failed:`, String(err))
    process.exit(1)
  }
}

// ── Consolidate ───────────────────────────────────────────────────
function runConsolidate(): void {
  // Check memory/ exists
  if (!existsSync(memoryDir)) {
    console.error(`consolidate: memory/ directory not found at ${memoryDir}`)
    process.exit(1)
  }

  // Check MEMORY.md exists
  const memIndexPath = path.join(memoryDir, "MEMORY.md")
  if (!existsSync(memIndexPath)) {
    console.error(`consolidate: MEMORY.md not found; run 'bun run bot.ts once "test"' first to initialize`)
    process.exit(1)
  }

  // Check git dirty status (warning only)
  try {
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 10_000,
    })
    if (status.stdout?.trim()) {
      console.warn(`[consolidate] Warning: git working tree is dirty. Consider committing before consolidate.`)
    }
  } catch {
    // git not available or not a repo; continue
  }

  try {
    const result = runMemoryConsolidate()
    console.log(result)
  } catch (err) {
    console.error(`consolidate failed:`, String(err))
    process.exit(1)
  }
}

// ── CLI ───────────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2)

if (command === "listen") {
  startListen()
} else if (command === "once") {
  const message = args.join(" ").trim()
  if (!message) throw new Error('Usage: bun run bot.ts once "message"')
  runOnce(message)
} else if (command === "import") {
  const distill = args.includes("--distill")
  const inputArg = args.find((a) => !a.startsWith("--"))
  if (!inputArg) throw new Error("Usage: bun run bot.ts import <file-or-url> [--distill]")
  void runImport(inputArg, distill)
} else if (command === "consolidate") {
  runConsolidate()
} else {
  console.log("Usage:")
  console.log("  bun run bot.ts listen")
  console.log('  bun run bot.ts once "message"')
  console.log("  bun run bot.ts import <file-or-url> [--distill]")
  console.log("  bun run bot.ts consolidate")
  process.exit(1)
}
