import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { rcmDir, cacheDir, botConfig, memoryDir } from "./config"

interface DispatchParams {
  eventName: string
  action: string
  fields: Record<string, string>
  cwd?: string
  debugPrefix?: string
}

interface DispatchResult {
  reply: string
  rcmPath?: string
  debugPath?: string
}

function extractRcmPath(output: string): string | undefined {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  return lines.reverse().find((l) => l.endsWith(".rcm"))
}

function extractRcmReply(output: string, debugPath?: string): string {
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
  throw new Error(`RCM produced empty stdout${debugPath ? `; debug log: ${debugPath}` : ""}`)
}

/**
 * Run RCM dispatch + run for any event.
 */
export function runRcmDispatch(params: DispatchParams): DispatchResult {
  const { eventName, action, fields, cwd, debugPrefix } = params
  const prefix = debugPrefix || eventName

  mkdirSync(cacheDir, { recursive: true })
  const eventPath = path.join(os.tmpdir(), `synergy_${prefix}_${Date.now()}.json`)
  writeFileSync(eventPath, JSON.stringify(fields, null, 2), "utf8")

  try {
    // Dispatch
    const dispatch = spawnSync(
      botConfig.rcmBin,
      [
        "dispatch",
        "--config",
        path.join(rcmDir, "dispatch.toml"),
        "--event-name",
        eventName,
        "--action",
        action,
        "--event-path",
        eventPath,
      ],
      { cwd: cwd || rcmDir, encoding: "utf8", timeout: 15_000 },
    )

    if (dispatch.status !== 0 || dispatch.error) {
      if (dispatch.error) {
        throw new Error(`dispatch failed: ${dispatch.error.message}`)
      }
      const errOut = dispatch.stderr || dispatch.stdout
      const errMsg = errOut ? errOut.trim().slice(0, 800) : `accelerate dispatch exited with status ${dispatch.status}`
      throw new Error(`dispatch failed: ${errMsg}`)
    }

    const rcmPath = extractRcmPath(dispatch.stdout)
    if (!rcmPath) {
      const out = (dispatch.stdout || "").trim().slice(0, 800)
      throw new Error(`dispatch returned no .rcm path: ${out}`)
    }

    // Run
    const run = spawnSync(botConfig.rcmBin, ["run", rcmPath, "--speed", "0"], {
      cwd: cwd || rcmDir,
      encoding: "utf8",
      timeout: botConfig.maxRunSeconds * 1000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: botConfig.deepseekApiKey,
        PATH: `${botConfig.ghPathPrefix}:${process.env.PATH || ""}`,
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
      "utf8",
    )

    if (run.status !== 0) {
      const errMsg = (run.stderr || run.stdout || "unknown error").trim().slice(0, 1200)
      throw new Error(`run failed for ${rcmPath}; debug log: ${debugPath}; ${errMsg}`)
    }

    const reply = extractRcmReply(run.stdout, debugPath)
    return { reply, rcmPath, debugPath }
  } finally {
    rmSync(eventPath, { force: true })
  }
}
