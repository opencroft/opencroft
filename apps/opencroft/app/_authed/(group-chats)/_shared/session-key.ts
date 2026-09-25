// A group-chat thread's session-key shape, in one dependency-free module —
// the same reason access-error.ts lives in _shared: model.ts's database tail
// must not ride along with a caller that only needs to read a key. The
// idle-session reaper is such a caller: it decides which agent a session
// belongs to from the key alone, and must not import the group-chat model to
// do it.

// A thread's session key is namespaced away from the 1:1 chat registry's
// `agent:<agent>:<job>[:<key>]` shape on purpose — the two must never collide
// even by coincidence, and a reader who sees this prefix knows immediately
// which registry a session belongs to without having to cross-reference
// either table.
export const SESSION_KEY_PREFIX = 'group-chat.'

export function isGroupChatSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(SESSION_KEY_PREFIX)
}

export function mintSessionKey(groupSlug: string, agentSlug: string, threadSlug: string): string {
  return `${SESSION_KEY_PREFIX}${groupSlug}.${agentSlug}.${threadSlug}`
}

export interface SessionKeyParts {
  chatSlug: string
  agentSlug: string
  threadSlug: string
}

/**
 * The inverse of `mintSessionKey`, and the ONLY thing that takes a group-chat
 * key apart. It exists because renaming has to re-mint a key while keeping the
 * segments the rename does not touch -- above all the agent's, which is frozen
 * at creation and must never be recomputed from a name that may have changed
 * since.
 *
 * Unambiguous because every segment is `slugify` output, whose alphabet is
 * `[a-z0-9-]` -- it cannot contain the separator, so a key with exactly four
 * segments splits exactly one way.
 *
 * NULL FOR ANYTHING ELSE, which is how a key from before slugs existed is
 * recognised. Those carry ids where these carry slugs, so no rename can stale
 * them -- and a caller handed null is being told to leave the key alone, not to
 * guess at its shape.
 */
export function partsOfSessionKey(sessionKey: string): SessionKeyParts | null {
  const match = /^group-chat\.([^.:]+)\.([^.:]+)\.([^.:]+)$/.exec(sessionKey)
  if (!match?.[1] || !match[2] || !match[3]) {
    return null
  }
  return { chatSlug: match[1], agentSlug: match[2], threadSlug: match[3] }
}

/**
 * How many of `sessionKeys` are threads of the chat addressed by `chatSlug` --
 * how many of one chat's threads sit in an activity set, say. A key of any
 * other shape counts for nothing.
 */
export function countChatThreadKeys(sessionKeys: Iterable<string>, chatSlug: string): number {
  let count = 0
  for (const key of sessionKeys) {
    if (partsOfSessionKey(key)?.chatSlug === chatSlug) {
      count += 1
    }
  }
  return count
}
