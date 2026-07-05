import { execFile } from "node:child_process"
import { mkdirSync, writeFileSync, readFileSync } from "node:fs"
import path from "node:path"
import { rcmDir, cacheDir, botConfig } from "./config"

const templateDir = path.join(rcmDir, "templates")

interface FieldMapping {
  [fieldName: string]: string // tpl var -> value key
}

const routes: Record<string, { template: string; fields: FieldMapping }> = {
  assistant: {
    template: "assistant.rcm.tpl",
    fields: {
      SESSION_ID: "session_id",
      REPORTER: "reporter",
      MESSAGE: "message",
      TARGET_REPO: "target_repo",
      REPO_PATH: "repo_path",
      SOURCE: "source",
      MEMORY_DIR: "memory_dir",
      ARCHIVE_DIR: "archive_dir",
      RECENT_CONTEXT_PATH: "recent_context_path",
      CHAT_ID: "chat_id",
      MESSAGE_ID: "message_id",
    },
  },
  memory_ingest: {
    template: "memory_ingest.rcm.tpl",
    fields: {
      SESSION_ID: "session_id",
      REPORTER: "reporter",
      MESSAGE: "message",
      REPLY: "reply",
      ACTION: "action",
      SOURCE: "source",
      MEMORY_DIR: "memory_dir",
    },
  },
  memory_consolidate: {
    template: "memory_consolidate.rcm.tpl",
    fields: {
      SESSION_ID: "session_id",
      MEMORY_DIR: "memory_dir",
      TARGET_REPO: "target_repo",
    },
  },
}

/**
 * Escape a value for embedding inside an RCM double-quoted string.
 * RCM strings use \" and \\ for escaping, and \n for newlines.
 */
function rcmEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
}

/**
 * Replace {{VAR}} placeholders in a template with escaped values.
 */
function interpolate(template: string, fields: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = fields[key]
    if (value === undefined) {
      return `{{${key}}}`
    }
    return rcmEscape(value)
  })
}

/**
 * Run a subprocess and return stdout.
 */
function execAsync(
  file: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: Record<string, string> },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }))
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

export interface DispatchResult {
  reply: string
  rcmPath: string
  debugPath: string
}

/**
 * Dispatch and run an RCM event using our own template engine.
 * Async — does NOT block the event loop.
 */
export async function runRcmDispatch(
  eventName: string,
  values: Record<string, string>,
  opts?: { envExtra?: Record<string, string>; cwd?: string },
): Promise<DispatchResult> {
  const route = routes[eventName]
  if (!route) {
    throw new Error(`Unknown RCM event: ${eventName}`)
  }

  // Build the field map from input values
  const fields: Record<string, string> = {}
  for (const [tplVar, valueKey] of Object.entries(route.fields)) {
    fields[tplVar] = values[valueKey] ?? ""
  }

  // Read template and interpolate
  const tplPath = path.join(templateDir, route.template)
  const template = readFileSync(tplPath, "utf8")
  const compiled = interpolate(template, fields)

  // Write compiled .rcm to cache
  mkdirSync(cacheDir, { recursive: true })
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "T")
  const rcmFileName = `${timestamp}-${route.template.replace(".tpl", "")}`
  const rcmPath = path.join(cacheDir, rcmFileName)
  writeFileSync(rcmPath, compiled, "utf8")

  // Run accelerator (async)
  const { stdout, stderr } = await execAsync(botConfig.rcmBin, ["run", rcmPath, "--speed", "0"], {
    cwd: opts?.cwd || rcmDir,
    timeout: botConfig.maxRunSeconds * 1000,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: botConfig.deepseekApiKey,
      PATH: `${botConfig.ghPathPrefix}:${process.env.PATH || ""}`,
      ...opts?.envExtra,
    },
  })

  const debugPath = path.join(cacheDir, `${rcmFileName}.run.log`)
  writeFileSync(
    debugPath,
    JSON.stringify(
      {
        rcmPath,
        stdout,
        stderr,
      },
      null,
      2,
    ),
    "utf8",
  )

  const reply = extractReply(stdout, debugPath)
  return { reply, rcmPath, debugPath }
}

function extractReply(output: string, debugPath?: string): string {
  let reply = ""
  let inResponse = false
  for (const line of output.trim().split("\n")) {
    if (line.includes("\u256d\u2500 Response")) {
      inResponse = true
      continue
    }
    if (inResponse && line.includes("\u2570")) {
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
  throw new Error(
    `RCM produced empty stdout${debugPath ? `; debug log: ${debugPath}` : ""}`,
  )
}
