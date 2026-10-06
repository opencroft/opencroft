import {
  db,
  groupChat,
  groupChatSlugAlias,
  groupChatThread,
  groupChatThreadAlias,
  space,
  spaceSlugAlias,
} from '@opencroft/db'
import { eq } from 'drizzle-orm'

// Which thread a session key addresses, and which space that thread's chat
// belongs to — answered from the tables alone, in a module whose only tail is
// the database. The usage recorder asks on every turn end from inside the agent
// engine, and the group-chat model imports that engine, so these lookups cannot
// live in the model without a cycle.

/**
 * THE ONE PLACE a session key is turned into a thread. Live first, then an
 * address a rename freed -- the rule every lookup here obeys, written once so a
 * caller cannot accidentally get the live half of it and not the other.
 *
 * Every site that resolves a key needs the alias half, not just the ones a
 * person reaches. A key can be captured in a closure and resolved a whole turn
 * later (see `requestCompact`), by which time a rename may have retired
 * it; a lookup without the fallback finds nothing and its caller carries on
 * with whatever "not a group-chat thread" means to it -- which, for the
 * compaction path, is dropping the history and then not restoring the topic,
 * pins and instructions that were the point of compacting.
 *
 * The alias row carries `threadId` directly, so this is one indexed read per
 * half and no join.
 */
export async function threadIdForSessionKey(sessionKey: string): Promise<string | null> {
  const [live] = await db
    .select({ id: groupChatThread.id })
    .from(groupChatThread)
    .where(eq(groupChatThread.sessionKey, sessionKey))
    .limit(1)
  if (live) {
    return live.id
  }
  const [aliased] = await db
    .select({ threadId: groupChatThreadAlias.threadId })
    .from(groupChatThreadAlias)
    .where(eq(groupChatThreadAlias.sessionKey, sessionKey))
    .limit(1)
  return aliased?.threadId ?? null
}

/**
 * The space a slug addresses — live slug first, then one a rename freed. Live
 * first is load-bearing: if another space has since taken the freed slug, the
 * space holding it now is the answer.
 */
export async function spaceIdBySlug(slug: string): Promise<string | null> {
  const [live] = await db.select({ id: space.id }).from(space).where(eq(space.slug, slug)).limit(1)
  if (live) {
    return live.id
  }
  const [aliased] = await db
    .select({ spaceId: spaceSlugAlias.spaceId })
    .from(spaceSlugAlias)
    .where(eq(spaceSlugAlias.slug, slug))
    .limit(1)
  return aliased?.spaceId ?? null
}

/**
 * The space the thread bound to `sessionKey` belongs to: its chat's slug, read
 * as a space address. A space's chat lives at the space's own slug (see
 * `CreateGroupChatOptions.slug`), and a space rename leaves that chat at the
 * old slug, which then resolves through the space's alias.
 *
 * A CHAT RENAME MOVES THE CHAT OFF THAT SLUG, and the space still owns it: the
 * space finds its chat through `chatRowBySlug`, live slug then the chat's slug
 * aliases. So this is that lookup inverted — the chat's live slug first, then
 * the slugs it was renamed away from. Two aliases naming two different spaces
 * means both spaces reach this chat, and picking one would credit the other's
 * spend to it, so that case resolves to no space. The migration that backfilled
 * the column applies the same order.
 *
 * Null for a key no thread holds, and for a thread whose chat sits at no
 * space's address — a chat created on its own rather than as a space's.
 */
export async function spaceIdForSessionKey(sessionKey: string): Promise<string | null> {
  const threadId = await threadIdForSessionKey(sessionKey)
  if (!threadId) {
    return null
  }
  const [chat] = await db
    .select({ id: groupChat.id, slug: groupChat.slug })
    .from(groupChatThread)
    .innerJoin(groupChat, eq(groupChat.id, groupChatThread.groupChatId))
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!chat) {
    return null
  }
  const live = await spaceIdBySlug(chat.slug)
  if (live) {
    return live
  }
  const aliases = await db
    .select({ slug: groupChatSlugAlias.slug })
    .from(groupChatSlugAlias)
    .where(eq(groupChatSlugAlias.groupChatId, chat.id))
  const spaceIds = new Set<string>()
  for (const alias of aliases) {
    const spaceId = await spaceIdBySlug(alias.slug)
    if (spaceId) {
      spaceIds.add(spaceId)
    }
  }
  return spaceIds.size === 1 ? [...spaceIds][0] : null
}
