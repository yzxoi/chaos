import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import path from "node:path"
import { memoryDir, archiveDir, MEMORY_INDEX_MAX_LINES, RECENT_CONTEXT_MAX_ROUNDS, isMempalaceEnabled, mempalaceConfig, rootDir } from "./config"

/**
 * Create a safe slug from arbitrary input.
 * Only a-z, A-Z, 0-9, underscore, hyphen, dot are kept; others replaced with '_'.
 * Truncated to maxLen (default 128).
 */
export function safeSlug(input: string, maxLen = 128): string {
  let slug = input.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "")
  if (slug.length === 0) slug = "unknown"
  if (slug.length > maxLen) slug = slug.slice(0, maxLen)
  return slug
}

/**
 * Ensure all memory/ and archive/ directories exist.
 */
export function ensureMemoryLayout(): void {
  mkdirSync(path.join(memoryDir, "imported"), { recursive: true })
  mkdirSync(path.join(archiveDir, "imports"), { recursive: true })
}

/**
 * Get the archive directory for a chat session.
 */
export function chatArchiveDir(chatId: string): string {
  return path.join(archiveDir, safeSlug(chatId))
}

/**
 * Ensure the recent context file exists for this chat, creating it if missing.
 * Returns the absolute file path.
 */
export function ensureRecentContext(chatId: string): string {
  const dir = chatArchiveDir(chatId)
  mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, "recent.md")
  if (!existsSync(filePath)) {
    writeFileSync(filePath, "# Recent Context\n\n<!-- Recent Q&A rounds, most recent last -->\n", "utf8")
  }
  return filePath
}

/**
 * Read current recent context entries.
 */
export function readRecentContext(chatId: string): Array<{ time: string; messageId: string; reporter: string; q: string; a: string; action: string }> {
  const filePath = path.join(chatArchiveDir(chatId), "recent.md")
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, "utf8")
  const entries: Array<{ time: string; messageId: string; reporter: string; q: string; a: string; action: string }> = []
  const parts = content.split("\n## Round ")
  for (const part of parts) {
    const tMatch = part.match(/^- Time: (.+)/m)
    const idMatch = part.match(/^- MessageId: (.+)/m)
    const rMatch = part.match(/^- Reporter: (.+)/m)
    const qMatch = part.match(/^### Q\n\n([\s\S]*?)(?:\n### A|\n## Round|\n<!--|$)/m)
    const aMatch = part.match(/^### A\n\n([\s\S]*?)(?:\n## Round|\n<!--|$)/m)
    const actMatch = part.match(/^- Action: (.+)/m)
    if (tMatch && idMatch && qMatch) {
      entries.push({
        time: tMatch[1],
        messageId: idMatch[1],
        reporter: rMatch?.[1] || "",
        q: qMatch[1].trim(),
        a: aMatch?.[1]?.trim() || "",
        action: actMatch?.[1]?.trim() || "answered",
      })
    }
  }
  return entries
}

/**
 * Update recent context with a new entry, trimming to the most recent N rounds.
 */
export function updateRecentContext(
  chatId: string,
  entry: { time: string; messageId: string; reporter: string; q: string; a: string; action: string },
): void {
  const slug = safeSlug(chatId)
  const dir = chatArchiveDir(slug)
  mkdirSync(dir, { recursive: true })
  let entries = readRecentContext(slug)
  entries.push(entry)
  // Trim to max rounds
  while (entries.length > RECENT_CONTEXT_MAX_ROUNDS) {
    entries.shift()
  }
  // Write
  const lines: string[] = ["# Recent Context", "", "<!-- Recent Q&A rounds, most recent last -->", ""]
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    lines.push(`## Round ${i + 1}`)
    lines.push(`- Time: ${e.time}`)
    lines.push(`- MessageId: ${e.messageId}`)
    lines.push(`- Reporter: ${e.reporter}`)
    lines.push(`- Action: ${e.action}`)
    lines.push("")
    lines.push("### Q")
    lines.push("")
    lines.push(e.q)
    lines.push("")
    lines.push("### A")
    lines.push("")
    lines.push(e.a)
    lines.push("")
  }
  writeFileSync(path.join(dir, "recent.md"), lines.join("\n"), "utf8")
}

/**
 * Infer the action from RCM output.
 * Returns one of: answered, issue_created:#N, known_issue:#N, asked_for_info, none
 */
export function inferAction(rcmOutput: string): string {
  // known_issue must come BEFORE issue_created: the known regex is more specific
  // (requires context keywords). The issue_created regex is a general "issue #N" catch-all
  // that would match known issues too if checked first.
  const known = rcmOutput.match(/issue\s+#(\d+).*(?:already|recorded|tracked|known|existing)/i)
  if (known) return `known_issue:#${known[1]}`
  const created = rcmOutput.match(/issue[_\s]?#(\d+)/i)
  if (created) return `issue_created:#${created[1]}`
  if (/ask|补充|supplement|more info|specific|步骤|version|平台/i.test(rcmOutput)) return "asked_for_info"
  if (/n\/a|none|skip|not applicable/i.test(rcmOutput)) return "none"
  return "answered"
}

/**
 * Write a Layer A archive entry.
 * Path: archive/<safe_chat_id>/<yyyy-mm-dd>-<safe_message_id>.md
 * Idempotent: overwrites existing file for same message_id.
 */
export function writeArchiveEntry(
  chatId: string,
  messageId: string,
  reporter: string,
  action: string,
  q: string,
  a: string,
): void {
  try {
    const slug = safeSlug(chatId)
    const msgSlug = safeSlug(messageId, 64)
    const date = new Date().toISOString().slice(0, 10)
    const dir = chatArchiveDir(slug)
    mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${date}-${msgSlug}.md`)

    const frontmatter = [
      "---",
      `chat_id: ${chatId}`,
      `message_id: ${messageId}`,
      `reporter: ${reporter}`,
      `time: ${new Date().toISOString()}`,
      `action: ${action}`,
      "---",
      "",
    ].join("\n")

    const body = [
      "## Q",
      "",
      q,
      "",
      "## A",
      "",
      a,
      "",
    ].join("\n")

    writeFileSync(filePath, frontmatter + body, "utf8")
  } catch (err) {
    console.warn(`[memory] archive write failed for msg ${messageId}:`, String(err))
  }
}

/**
 * Chunk text for import.
 * Strategy:
 *   1. Try markdown heading-level splits (## or ### headings)
 *   2. Fall back to double-newline splits
 *   3. Hard-split chunks exceeding ~4000 chars
 */
export function chunkText(text: string): string[] {
  // Try heading-level markdown splits first
  const headingRegex = /^(#{2,3}\s+.+)$/gm
  const headingMatches: Array<{ index: number; heading: string }> = []
  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(text)) !== null) {
    headingMatches.push({ index: match.index, heading: match[0] })
  }

  let rawChunks: string[]
  if (headingMatches.length > 1) {
    rawChunks = []
    for (let i = 0; i < headingMatches.length; i++) {
      const start = headingMatches[i].index
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : text.length
      rawChunks.push(text.slice(start, end).trim())
    }
  } else {
    // Split by double newlines
    rawChunks = text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean)
  }

  // Hard-split chunks exceeding maxChars
  const maxChars = 4000
  const finalChunks: string[] = []
  for (const chunk of rawChunks) {
    if (chunk.length <= maxChars) {
      finalChunks.push(chunk)
    } else {
      // Hard split on sentence boundaries if possible
      for (let i = 0; i < chunk.length; i += maxChars) {
        let end = Math.min(i + maxChars, chunk.length)
        // Try to break at a newline or period near the boundary
        if (end < chunk.length) {
          const near = chunk.slice(end - 100, end + 100)
          const nlIdx = near.lastIndexOf("\n")
          const periodIdx = near.lastIndexOf(". ")
          const breakAt = nlIdx > 50 ? nlIdx : periodIdx > 50 ? periodIdx : maxChars
          end = i + Math.max(100, breakAt)
          if (end > chunk.length) end = chunk.length
        }
        finalChunks.push(chunk.slice(i, end).trim())
        if (end >= chunk.length) break
      }
    }
  }

  return finalChunks.filter((c) => c.length > 0)
}

/**
 * Load a source for import (local file or URL).
 */
export async function loadImportSource(input: string): Promise<{ text: string; sourceSlug: string }> {
  let text: string
  let sourceSlug: string

  if (input.startsWith("http://") || input.startsWith("https://")) {
    const resp = await fetch(input)
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`)
    text = await resp.text()
    sourceSlug = safeSlug(new URL(input).hostname + "-" + path.basename(new URL(input).pathname), 64)
  } else {
    // Local file
    const absPath = path.resolve(rootDir, input)
    if (!existsSync(absPath)) {
      throw new Error(`file not found: ${absPath}`)
    }
    const stat = statSync(absPath)
    if (!stat.isFile()) throw new Error(`not a file: ${absPath}`)
    text = readFileSync(absPath, "utf8")
    sourceSlug = safeSlug(path.basename(input).replace(/\.[^.]+$/, ""), 64)
  }

  return { text, sourceSlug }
}

/**
 * Write import chunks to archive/imports/<source_slug>/.
 * Returns list of written file paths and the archive directory.
 */
export function writeImportChunks(
  sourceSlug: string,
  chunks: string[],
  source: string,
  distill: boolean,
): { paths: string[]; archiveDir: string } {
  const importDir = path.join(archiveDir, "imports", safeSlug(sourceSlug, 64))
  mkdirSync(importDir, { recursive: true })
  const paths: string[] = []
  const now = new Date().toISOString()

  for (let i = 0; i < chunks.length; i++) {
    const frontmatter = [
      "---",
      `source: ${source}`,
      `source_slug: ${safeSlug(sourceSlug, 64)}`,
      `time: ${now}`,
      `chunk_index: ${i}`,
      `distill: ${distill}`,
      "---",
      "",
    ].join("\n")

    const filePath = path.join(importDir, `${i}.md`)
    writeFileSync(filePath, frontmatter + chunks[i] + "\n", "utf8")
    paths.push(filePath)
  }

  return { paths, archiveDir: importDir }
}

/**
 * Run mempalace mine on a directory asynchronously (fire-and-forget).
 * Does not throw — logs failures as warnings.
 */
export async function runMempalaceMine(dir: string, wing: string): Promise<void> {
  if (!isMempalaceEnabled()) {
    console.log(`[mempalace] disabled or binary not found, skipping mine for ${wing}`)
    return
  }
  const args = ["mine", dir, "--mode", "convos", "--wing", wing]
  if (mempalaceConfig.palacePath) {
    args.push("--palace", mempalaceConfig.palacePath)
  }
  try {
    const proc = spawn(mempalaceConfig.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    })
    let stdout = ""
    let stderr = ""
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    await new Promise<void>((resolve) => {
      proc.on("exit", (code) => {
        if (code === 0) {
          console.log(`[mempalace] mine ${wing} succeeded`)
        } else {
          console.warn(`[mempalace] mine ${wing} exited code=${code}: ${stderr.slice(0, 500)}`)
        }
        resolve()
      })
      proc.on("error", (err: Error) => {
        console.warn(`[mempalace] mine ${wing} error:`, err.message)
        resolve()
      })
    })
  } catch (err) {
    console.warn(`[mempalace] mine ${wing} failed:`, String(err))
  }
}
