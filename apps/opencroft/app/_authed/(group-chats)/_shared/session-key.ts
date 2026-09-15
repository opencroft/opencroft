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

// The storage form from before the dot migration. Stored rows in this form
// still exist until the migration has run on a given database, and addresses
// written down elsewhere keep it far longer -- so parsing accepts both while
// ONLY the dot form is ever minted. This constant, and every branch reading
// it, is what the contract phase deletes once no stored key and no stored
// reference carries a colon.
export const LEGACY_SESSION_KEY_PREFIX = 'group-chat:'

/** Either stored spelling of a group-chat thread key, old or new. */
export function isGroupChatSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith(SESSION_KEY_PREFIX) || sessionKey.startsWith(LEGACY_SESSION_KEY_PREFIX)
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
 * `[a-z0-9-]` -- it can contain neither separator, so a key with exactly four
 * segments splits exactly one way in either spelling.
 *
 * BOTH stored spellings parse, and only the dot form is minted -- which means
 * any re-mint (a chat or thread rename) migrates a lingering colon key's
 * format as a side effect of the rename, through the same key-move machinery
 * the migration itself drives.
 *
 * NULL FOR ANYTHING ELSE, which is how a key from before slugs existed is
 * recognised. Those carry ids where these carry slugs, so no rename can stale
 * them -- and a caller handed null is being told to leave the key alone, not to
 * guess at its shape.
 */
export function partsOfSessionKey(sessionKey: string): SessionKeyParts | null {
  const match =
    /^group-chat\.([^.:]+)\.([^.:]+)\.([^.:]+)$/.exec(sessionKey) ??
    /^group-chat:([^.:]+):([^.:]+):([^.:]+)$/.exec(sessionKey)
  if (!match?.[1] || !match[2] || !match[3]) {
    return null
  }
  return { chatSlug: match[1], agentSlug: match[2], threadSlug: match[3] }
}
