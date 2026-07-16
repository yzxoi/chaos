import { execFile } from "node:child_process"
import { chmodSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import path from "node:path"
import { rcmDir, cacheDir, botConfig } from "./config"

const templateDir = path.join(rcmDir, "templates")

interface FieldMapping {
  [fieldName: string]: string // tpl var -> value key
}

interface DispatchRoute {
  template: string
  fields: FieldMapping
  requiredEnv?: string[]
}

const routes: Record<string, DispatchRoute> = {
  assistant: {
    template: "assistant.rcm.tpl",
    requiredEnv: ["ANYSEARCH_API_KEY"],
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

const inheritedEnvironmentKeys = [
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "XDG_CONFIG_HOME",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSH_AUTH_SOCK",
] as const

function inheritedRcmEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    inheritedEnvironmentKeys.flatMap(name =>
      source[name] === undefined ? [] : [[name, source[name]]],
    ),
  )
}

export function redactSensitiveOutput(output: string, env: NodeJS.ProcessEnv): string {
  let redacted = output
  const sensitiveValues = Object.entries(env)
    .filter(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(name))
    .map(([, value]) => value as string)
    .filter(value => value.length >= 8)
    .sort((a, b) => b.length - a.length)

  for (const value of sensitiveValues) {
    redacted = redacted.split(value).join("[REDACTED]")
  }

  return redacted
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:as_sk_|sk-|ghp_|github_pat_)[A-Za-z0-9_-]+\b/g, "[REDACTED]")
}

/**
 * Run a subprocess and return stdout.
 */
function execAsync(
  file: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => {
      const safeStdout = redactSensitiveOutput(stdout, opts.env ?? {})
      const safeStderr = redactSensitiveOutput(stderr, opts.env ?? {})
      if (err) {
        err.message = redactSensitiveOutput(err.message, opts.env ?? {})
        reject(Object.assign(err, { stdout: safeStdout, stderr: safeStderr }))
      } else {
        resolve({ stdout: safeStdout, stderr: safeStderr })
      }
    })
  })
}

export function buildRcmEnvironment(
  envExtra?: NodeJS.ProcessEnv,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...inheritedRcmEnvironment(parentEnv),
    DEEPSEEK_API_KEY: botConfig.deepseekApiKey,
    ANYSEARCH_API_KEY: botConfig.anysearchApiKey,
    PATH: `${botConfig.ghPathPrefix}:${parentEnv.PATH || ""}`,
    ...envExtra,
  }
}

export function validateDispatchEnvironment(eventName: string, env: NodeJS.ProcessEnv): void {
  const route = routes[eventName]
  if (!route) {
    throw new Error(`Unknown RCM event: ${eventName}`)
  }

  for (const name of route.requiredEnv ?? []) {
    if (!env[name]?.trim()) {
      throw new Error(`Missing required env: ${name}`)
    }
  }
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
  opts?: { envExtra?: NodeJS.ProcessEnv; cwd?: string },
): Promise<DispatchResult> {
  const route = routes[eventName]
  if (!route) {
    throw new Error(`Unknown RCM event: ${eventName}`)
  }

  const subprocessEnv = buildRcmEnvironment(opts?.envExtra)
  validateDispatchEnvironment(eventName, subprocessEnv)

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
  chmodSync(cacheDir, 0o700)
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
  const rcmFileName = `${timestamp}-${route.template.replace(".tpl", "")}`
  const rcmPath = path.join(cacheDir, rcmFileName)
  writeFileSync(rcmPath, compiled, { encoding: "utf8", mode: 0o600 })

  // `mode` only applies when creating a file; also tighten a same-second cache collision.
  chmodSync(rcmPath, 0o600)
  // Run accelerator (async)
  const { stdout, stderr } = await execAsync(botConfig.rcmBin, ["run", rcmPath, "--speed", "0"], {
    cwd: opts?.cwd || rcmDir,
    timeout: botConfig.maxRunSeconds * 1000,
    env: subprocessEnv,
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
    { encoding: "utf8", mode: 0o600 },
  )

  // `mode` only applies when creating a file; also tighten a same-second cache collision.
  chmodSync(debugPath, 0o600)
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
