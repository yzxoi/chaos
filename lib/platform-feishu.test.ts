import { describe, expect, test } from "bun:test"
import { isSelfMentioned } from "./feishu-mention"
import { resolveBotIdentity } from "./platform-feishu"

describe("isSelfMentioned", () => {
  test("ignores mentions for other bots", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Other Bot",
            mentioned_type: "bot",
            id: { open_id: "ou_other" },
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(false)
  })

  test("matches this bot by open id", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Chaos Bot",
            mentioned_type: "bot",
            id: { open_id: "ou_self" },
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(true)
  })

  test("matches the real Feishu flat mention schema", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Chaos Bot",
            id: "ou_self",
            id_type: "open_id",
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(true)
  })

  test("rejects flat mention ids that are not open ids", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Chaos Bot",
            id: "ou_self",
            id_type: "user_id",
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(false)
  })

  test("rejects flat mention ids without an id type", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Chaos Bot",
            id: "ou_self",
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(false)
  })

  test("does not use a matching name when stable ids differ", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Chaos Bot",
            mentioned_type: "bot",
            id: { open_id: "ou_other" },
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(false)
  })

  test("does not wake from a matching name without a stable id", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Chaos Bot",
            mentioned_type: "bot",
            id: { open_id: "ou_self" },
          },
        ],
        { name: "Chaos Bot" },
      ),
    ).toBe(false)
  })

  test("does not treat broadcast mentions as self mentions", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@all",
            name: "All",
            mentioned_type: "bot",
            id: { open_id: "ou_self" },
          },
        ],
        { openId: "ou_self", name: "Chaos Bot" },
      ),
    ).toBe(false)
  })

  test("does not wake without known identity", () => {
    expect(
      isSelfMentioned(
        [
          {
            key: "@_user_1",
            name: "Some Bot",
            mentioned_type: "bot",
            id: { open_id: "ou_self" },
          },
        ],
        {},
      ),
    ).toBe(false)
  })
})

describe("resolveBotIdentity", () => {
  test("discovers the authenticated bot open id through the public API", async () => {
    const client = fakeClient({
      code: 0,
      msg: "ok",
      bot: { open_id: "ou_self", app_name: "Chaos Bot" },
    })

    await expect(resolveBotIdentity(client, {})).resolves.toEqual({
      openId: "ou_self",
      name: "Chaos Bot",
    })
  })

  test("fails closed when the identity API response shape is invalid", async () => {
    const client = fakeClient({
      code: "0",
      bot: { open_id: "ou_self" },
    })

    await expect(resolveBotIdentity(client, {})).rejects.toThrow("configure FEISHU_BOT_OPEN_ID")
  })

  test("does not expose the raw identity API error message", async () => {
    const client = fakeClient({
      code: 999,
      msg: "sensitive tenant routing details",
    })

    try {
      await resolveBotIdentity(client, {})
      throw new Error("expected identity resolution to fail")
    } catch (err) {
      expect(String(err)).not.toContain("sensitive tenant routing details")
    }
  })

  test("rejects a configured open id that conflicts with the authenticated bot", async () => {
    const client = fakeClient({
      code: 0,
      msg: "ok",
      bot: { open_id: "ou_self", app_name: "Chaos Bot" },
    })

    await expect(resolveBotIdentity(client, { openId: "ou_other" })).rejects.toThrow(
      "Configured FEISHU_BOT_OPEN_ID does not match",
    )
  })

  test("uses a configured stable id when identity discovery fails", async () => {
    const client = fakeClientError(new Error("network unavailable"))

    await expect(resolveBotIdentity(client, { openId: "ou_self" })).resolves.toEqual({
      openId: "ou_self",
    })
  })

  test("fails closed when neither discovery nor stable configuration is available", async () => {
    const client = fakeClientError(new Error("network unavailable"))

    await expect(resolveBotIdentity(client, {})).rejects.toThrow("configure FEISHU_BOT_OPEN_ID")
  })
})

function fakeClient(response: unknown): Parameters<typeof resolveBotIdentity>[0] {
  return {
    request: async <T>() => response as T,
  }
}

function fakeClientError(error: Error): Parameters<typeof resolveBotIdentity>[0] {
  return {
    request: async () => {
      throw error
    },
  }
}
