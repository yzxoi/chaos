#!/usr/bin/env bun
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

import type { MessageContext } from "./lib/platform"
import {
  rootDir,
  rcmDir,
  memoryDir,
  archiveDir,
  botConfig,
  MEMORY_INDEX_MAX_LINES,
  RECENT_CONTEXT_MAX_ROUNDS,
  enabledPlatforms,
  qqBridgePort,
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
import type { PlatformAdapter } from "./lib/platform"

// ── Ingest queue (single-concurrent) ──────────────────────────────
let ingestQueue: Promise<void> = Promise.resolve()

function enqueueIngest(fn: () => Promise<void>): void {
  ingestQueue = ingestQueue.then(fn, fn)
}

// ── Dedup ──────────────────────────────────────────────────────────
const recentMessageIds = new Set<string>()

function isDuplicateMessage(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) return true
  recentMessageIds.add(messageId)
  setTimeout(() => recentMessageIds.delete(messageId), 5 * 60_000)
  return false
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
async function runAssistant(input: {
  sessionId: string
  reporter: string
  message: string
  source: string
  chatId: string
  messageId: string
}): Promise<{ reply: string }> {
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

  const result = await runRcmDispatch("assistant", fields)
  return { reply: result.reply }
}

async function runMemoryIngest(input: {
  sessionId: string
  reporter: string
  message: string
  reply: string
  action: string
  source: string
}): Promise<void> {
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
    await runRcmDispatch("memory_ingest", fields, { cwd: memoryDir })
  } catch (err) {
    console.warn(`[ingest] failed:`, String(err))
  }
}

async function runMemoryConsolidate(): Promise<string> {
  const fields: Record<string, string> = {
    session_id: `consolidate_${Date.now()}`,
    memory_dir: memoryDir,
    target_repo: botConfig.targetRepo,
  }
  const result = await runRcmDispatch("memory_consolidate", fields, { cwd: memoryDir })
  return result.reply
}

// ── Core pipeline (platform-agnostic) ─────────────────────────────

function createMessageHandler(adapter: PlatformAdapter) {
  return async (ctx: MessageContext) => {
    const { message, sender, parentText, platform } = ctx
    const messageId = message.messageId
    const chatId = message.chatId

    // ── Guards ────────────────────────────────────────────────
    if (isDuplicateMessage(messageId)) {
      console.log(`[${platform}] skipped duplicate: ${messageId}`)
      return
    }

    const now = Date.now()
    if (message.timestamp > 0 && (now - message.timestamp > 10_000 || message.timestamp > now + 5_000)) {
      console.log(`[${platform}] skipped stale/future: ${messageId} diff=${now - message.timestamp}ms`)
      return
    }

    // ── Build context ─────────────────────────────────────────
    const reporter = sender.userId
    const source = `${platform}:${chatId}; message:${messageId}`
    const sessionId = `${platform}_${messageId.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24) || Date.now()}`
    const slugChatId = safeSlug(chatId)

    let fullMessage = message.text
    if (parentText) {
      fullMessage = `[回复: ${parentText}]\n${message.text}`
      console.log(`[${platform}] quoted parent: ${parentText.slice(0, 100)}`)
    }

    console.log(`[${platform}] received ${messageId}: ${message.text.slice(0, 120)}`)

    // ── Run assistant ─────────────────────────────────────────
    try {
      const result = await runAssistant({
        sessionId,
        reporter,
        message: fullMessage,
        source,
        chatId,
        messageId,
      })
      console.log(`[${platform}] reply: ${result.reply}`)

      // ── Reply ───────────────────────────────────────────
      await adapter.reply(messageId, result.reply)
      console.log(`[${platform}] reply sent`)

      // ── Layer A: archive ─────────────────────────────────
      const action = inferAction(result.reply)
      writeArchiveEntry(chatId, messageId, reporter, action, fullMessage, result.reply)

      // Update recent context
      updateRecentContext(slugChatId, {
        time: new Date().toISOString(),
        messageId,
        reporter,
        q: fullMessage,
        a: result.reply,
        action,
      })

      // Mempalace mine (fire-and-forget)
      runMempalaceMine(chatArchiveDir(slugChatId), slugChatId)

      // ── Layer B: ingest ──────────────────────────────────
      enqueueIngest(async () => {
        try {
          await runMemoryIngest({
            sessionId,
            reporter,
            message: fullMessage,
            reply: result.reply,
            action,
            source,
          })
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
      console.error(`[${platform}] processing failed:`, err)
      await adapter.reply(messageId, "⚠️ 处理失败，请稍后再试或联系 yzx 查看日志。").catch(() => {})
    }
  }
}

// ── Start platforms ───────────────────────────────────────────────
function startPlatforms() {
  ensureMemoryLayout()

  if (enabledPlatforms.length === 0) {
    console.error("No platforms enabled. Set PLATFORMS in .env (e.g. PLATFORMS=feishu,qq)")
    process.exit(1)
  }

  for (const platform of enabledPlatforms) {
    console.log(`[boot] loading platform: ${platform}`)

    switch (platform) {
      case "feishu": {
        import("./lib/platform-feishu").then((mod) => {
          const adapter = mod.createFeishuAdapter()
          const handler = createMessageHandler(adapter)
          adapter.listen(handler)
          console.log(`[feishu] adapter started`)
        })
        break
      }
      case "qq": {
        import("./lib/platform-qq").then((mod) => {
          const adapter = mod.createQQAdapter(qqBridgePort)
          const handler = createMessageHandler(adapter)
          adapter.listen(handler)
          console.log(`[qq] bridge listening on :${qqBridgePort}`)
        })
        break
      }
      default:
        console.warn(`[boot] unknown platform: ${platform}`)
    }
  }
}

// ── Once (manual test) ────────────────────────────────────────────
async function runOnce(message: string) {
  const sessionId = `manual_${Date.now()}`
  const { reply } = await runAssistant({
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

    const { archiveDir: importArchiveDir } = writeImportChunks(sourceSlug, chunks, inputArg, distill)
    console.log(`import: ${chunks.length} chunks written to ${importArchiveDir}`)

    const mempalaceWing = `imports-${sourceSlug}`
    await runMempalaceMine(importArchiveDir, mempalaceWing)

    let remembered = 0
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
        })
      }
      await ingestQueue
    }

    console.log(`--- Import Summary ---`)
    console.log(`Source: ${inputArg}`)
    console.log(`Chunks: ${chunks.length}`)
    console.log(`Archive: ${importArchiveDir}`)
    console.log(`Distill: ${distill ? `yes (remembered=${remembered}, skipped=${skipped})` : "no"}`)
  } catch (err) {
    console.error(`import failed:`, String(err))
    process.exit(1)
  }
}

// ── Consolidate ───────────────────────────────────────────────────
async function runConsolidate(): Promise<void> {
  if (!existsSync(memoryDir)) {
    console.error(`consolidate: memory/ directory not found at ${memoryDir}`)
    process.exit(1)
  }

  const memIndexPath = path.join(memoryDir, "MEMORY.md")
  if (!existsSync(memIndexPath)) {
    console.error(`consolidate: MEMORY.md not found; run 'bun run bot.ts once "test"' first to initialize`)
    process.exit(1)
  }

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
    // git not available; continue
  }

  try {
    const result = await runMemoryConsolidate()
    console.log(result)
  } catch (err) {
    console.error(`consolidate failed:`, String(err))
    process.exit(1)
  }
}

// ── CLI ───────────────────────────────────────────────────────────
const [command, ...args] = process.argv.slice(2)

if (command === "listen") {
  startPlatforms()
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
  void runConsolidate()
} else {
  console.log("Usage:")
  console.log("  bun run bot.ts listen")
  console.log('  bun run bot.ts once "message"')
  console.log("  bun run bot.ts import <file-or-url> [--distill]")
  console.log("  bun run bot.ts consolidate")
  process.exit(1)
}
