import { expect, test } from "bun:test"
import {
  buildRcmEnvironment,
  redactSensitiveOutput,
  validateDispatchEnvironment,
} from "./dispatch"
import { readFileSync } from "node:fs"
import path from "node:path"

const templatePath = path.join(import.meta.dir, "..", "rcm-synergy", "templates", "assistant.rcm.tpl")
const template = readFileSync(templatePath, "utf8")

test("assistant template enables authenticated AnySearch MCP without embedding a key", () => {
  expect(template).toContain("mcp anysearch {")
  expect(template).toContain('transport = http')
  expect(template).toContain('url = "https://api.anysearch.com/mcp"')
  expect(template).toContain('headers = { Authorization = "Bearer ${ANYSEARCH_API_KEY}" }')
  expect(template).toContain('mcps = ["anysearch"]')
  expect(template).not.toMatch(/Bearer\s+as_sk_[A-Za-z0-9]+/)
})

test("assistant template uses tools available across supported RCM versions", () => {
  expect(template).toContain('tools = ["shell", "find"]')
  expect(template).not.toContain('tools = ["shell", "find", "fs"]')
})

test("assistant prompt documents the namespaced AnySearch tools", () => {
  for (const tool of [
    "anysearch__search",
    "anysearch__batch_search",
    "anysearch__extract",
    "anysearch__get_sub_domains",
  ]) {
    expect(template).toContain(tool)
  }
})

test("assistant dispatch injects the AnySearch key into the RCM subprocess environment", () => {
  const env = buildRcmEnvironment({ ANYSEARCH_API_KEY: "test_anysearch_key" })

  expect(env.ANYSEARCH_API_KEY).toBe("test_anysearch_key")
  expect(() => validateDispatchEnvironment("assistant", env)).not.toThrow()
})

test("assistant dispatch rejects a missing AnySearch key", () => {
  expect(() =>
    validateDispatchEnvironment("assistant", { ANYSEARCH_API_KEY: "   " }),
  ).toThrow("Missing required env: ANYSEARCH_API_KEY")
})

test("routes without MCP dependencies do not require the AnySearch key", () => {
  expect(() => validateDispatchEnvironment("memory_ingest", {})).not.toThrow()
})

test("RCM subprocess receives only allowlisted parent environment variables", () => {
  const env = buildRcmEnvironment(
    { ANYSEARCH_API_KEY: "test_anysearch_key" },
    {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      GITHUB_TOKEN: "github_test_token",
      FEISHU_APP_SECRET: "must_not_reach_rcm",
    },
  )

  expect(env.PATH).toEndWith(":/usr/bin")
  expect(env.HOME).toBe("/tmp/home")
  expect(env.GITHUB_TOKEN).toBe("github_test_token")
  expect(env.FEISHU_APP_SECRET).toBeUndefined()
})

test("RCM output is redacted before it can be logged or returned", () => {
  const output = [
    "Authorization: Bearer as_sk_visible",
    "deepseek=sk-visible",
    "github=github_test_token",
  ].join("\n")
  const redacted = redactSensitiveOutput(output, {
    ANYSEARCH_API_KEY: "as_sk_visible",
    DEEPSEEK_API_KEY: "sk-visible",
    GITHUB_TOKEN: "github_test_token",
  })

  expect(redacted).not.toContain("as_sk_visible")
  expect(redacted).not.toContain("sk-visible")
  expect(redacted).not.toContain("github_test_token")
  expect(redacted).toContain("[REDACTED]")
})
