import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"

export const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
export const rcmDir = path.join(rootDir, "rcm-synergy")
export const cacheDir = path.join(rcmDir, ".rcm-cache")
export const memoryDir = path.join(rootDir, "memory")
export const archiveDir = path.join(rootDir, "archive")

export const DEFAULT_TARGET_REPO = "owner/repo"
export const DEFAULT_RCM_BIN = "accelerate"
export const DEFAULT_REPO_PATH = "./repo"
export const MEMORY_INDEX_MAX_LINES = 200
export const RECENT_CONTEXT_MAX_ROUNDS = 5

export const mempalaceConfig = {
  bin: process.env.MEMPALACE_BIN?.trim() || "mempalace",
  enabled: (process.env.MEMPALACE_ENABLED?.trim() || "auto") as "auto" | "true" | "false",
  palacePath: process.env.MEMPALACE_PALACE_PATH?.trim() || "",
}

// Platform adapters to enable
export const enabledPlatforms: string[] = (process.env.PLATFORMS || "feishu")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

// QQ bridge port
export const qqBridgePort = parseInt(process.env.QQ_BRIDGE_PORT || "18080", 10)

export const botConfig = {
  appId: process.env.FEISHU_APP_ID?.trim() || "",
  appSecret: process.env.FEISHU_APP_SECRET?.trim() || "",
  rcmBin: process.env.RCM_BIN || DEFAULT_RCM_BIN,
  repoPath: process.env.REPO_PATH || DEFAULT_REPO_PATH,
  targetRepo: process.env.TARGET_REPO || DEFAULT_TARGET_REPO,
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  ghPathPrefix: process.env.GH_PATH_PREFIX || "gh",
  maxRunSeconds: Number(process.env.RCM_RUN_TIMEOUT_SECONDS || "420"),
}

export function isMempalaceEnabled(): boolean {
  if (mempalaceConfig.enabled === "false") return false
  // auto or true: check if binary exists
  try {
    const result = spawnSync(mempalaceConfig.bin, ["--help"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return result.status === 0
  } catch {
    return false
  }
}
