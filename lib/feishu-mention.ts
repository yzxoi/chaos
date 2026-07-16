export type FeishuBotIdentity = {
  openId?: string
  name?: string
}

export type FeishuMention = {
  key: string
  name?: string
  id?: string | { open_id?: string; user_id?: string; union_id?: string }
  id_type?: string
  mentioned_type?: string
}

function mentionOpenId(mention: FeishuMention): string | undefined {
  if (typeof mention.id === "string") {
    return mention.id_type === "open_id" ? mention.id : undefined
  }
  return mention.id?.open_id
}

function mentionMatchesIdentity(mention: FeishuMention, identity: FeishuBotIdentity): boolean {
  return Boolean(identity.openId && mentionOpenId(mention) === identity.openId)
}

export function isSelfMentioned(mentions: FeishuMention[] | undefined, identity: FeishuBotIdentity): boolean {
  if (!mentions?.length) return false
  if (!identity.openId) return false

  return mentions.some((mention) => {
    if (mention.key === "@all" || mention.key === "@_all") return false
    return mentionMatchesIdentity(mention, identity)
  })
}
