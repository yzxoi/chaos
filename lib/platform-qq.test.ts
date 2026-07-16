import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createQQAdapter } from "./platform-qq"
import type { PlatformAdapter } from "./platform"

const port = 20_000 + Math.floor(Math.random() * 10_000)
const baseUrl = `http://127.0.0.1:${port}`
let adapter: PlatformAdapter
const handled = new Set<string>()

beforeAll(async () => {
  adapter = createQQAdapter(port)
  adapter.listen(async (ctx) => {
    await adapter.reply(ctx.message.messageId, `reply:${ctx.message.messageId}`)
    handled.add(ctx.message.messageId)
  })
  await waitFor(async () => (await fetch(`${baseUrl}/qq/health`)).ok)
})

afterAll(async () => {
  await adapter.shutdown?.()
})

describe("QQ pending reply claims", () => {
  test("claiming one message leaves concurrent replies available", async () => {
    const firstId = "qq-one&first"
    const secondId = "qq-two"

    await Promise.all([postMessage(firstId), postMessage(secondId)])
    await waitFor(() => handled.has(firstId) && handled.has(secondId))

    const wildcardResponse = await fetch(`${baseUrl}/qq/pending-replies`)
    expect(wildcardResponse.status).toBe(400)
    expect(await wildcardResponse.json()).toEqual({ error: "message_id is required" })

    const first = await claimReply(firstId)
    expect(first).toEqual({ [firstId]: `reply:${firstId}` })

    const firstAgain = await claimReply(firstId)
    expect(firstAgain).toEqual({})

    const second = await claimReply(secondId)
    expect(second).toEqual({ [secondId]: `reply:${secondId}` })
  })

  test("rejects malformed JSON without invoking the handler", async () => {
    const handledBefore = handled.size
    const response = await fetch(`${baseUrl}/qq/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid JSON body" })
    expect(handled.size).toBe(handledBefore)
  })
})

async function postMessage(messageId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/qq/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message_id: messageId,
      chat_id: "test-chat",
      sender_id: "test-user",
      sender_name: "Tester",
      text: "hello",
      is_group: false,
      timestamp: Date.now(),
      parent_text: null,
      parent_id: null,
    }),
  })
  expect(response.status).toBe(200)
}

async function claimReply(messageId: string): Promise<Record<string, string>> {
  const query = new URLSearchParams({ message_id: messageId })
  const response = await fetch(`${baseUrl}/qq/pending-replies?${query}`)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, string>
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      // The test server may not be listening yet.
    }
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for test condition")
}
