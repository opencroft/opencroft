// Retiring session state that no group-chat thread owns.
//
// Every key-addressed store -- the three settings rows, the durable queue, the
// transcript and the attachments -- files a thread's state under its session
// key, and deleting a thread retires that key everywhere. A key can still
// outlive its thread: a delivery that resolved the row just before a delete
// re-creates the session just after it, and a database edited outside the app
// leaves whatever it leaves. Nothing reads such a key again, so its entries
// are inert, but they sit in the stores forever and read as live state to
// anyone counting them.
//
// OWNED means the key is a live thread's `sessionKey`, and nothing else does.
// Spelling decides nothing: an orphan can carry either separator. A key that
// is a live thread's ALIAS is kept and reported rather than swept, because a
// rename interrupted between its halves leaves the thread's state under that
// key until the next move settles it.
//
// FAIL CLOSED. The sweep deletes, at start, on every instance, so any sign
// that it is reading the wrong picture of who owns what stops it before it
// touches anything: an owner read that throws, no threads at all beside
// stored keys, or more than half the stored keys unowned. Each refusal says
// why, and the next start looks again.

import {
  agentQueueEntry,
  agentSessionEvent,
  chatAttachment,
  db,
  groupChatThread,
  groupChatThreadAlias,
} from '@opencroft/db'
import { like } from 'drizzle-orm'

import { forgetLocalSessionImpl } from '@/app/_authed/(agent)/_server/acp-impl'
import { tabKeysBySetting } from '@/app/_authed/(agent)/_server/acp-session-store'

/** A group-chat key in either separator -- the orphans this sweeps can carry both. */
const GROUP_CHAT_KEY = /^group-chat[.:]/

/** How many swept or kept keys are logged one per line before the rest are counted. */
const LISTED_KEYS = 50

export interface StoredKey {
  key: string
  stores: string[]
}

export interface SessionKeyOwners {
  threads: Set<string>
  aliases: Set<string>
}

export type OrphanSweepReport = { refused: string } | { forgotten: StoredKey[]; aliasHeld: StoredKey[]; stored: number }

async function distinctKeys(table: typeof agentQueueEntry | typeof agentSessionEvent | typeof chatAttachment) {
  const rows = await db
    .selectDistinct({ key: table.sessionKey })
    .from(table)
    .where(like(table.sessionKey, 'group-chat%'))
  return rows.map((row) => row.key)
}

/** Every group-chat key any store holds, with the stores holding it. */
export async function storedGroupChatKeys(): Promise<Map<string, string[]>> {
  const stored = new Map<string, string[]>()
  const add = (store: string, keys: Iterable<string>) => {
    for (const key of keys) {
      if (GROUP_CHAT_KEY.test(key)) {
        stored.set(key, [...(stored.get(key) ?? []), store])
      }
    }
  }
  for (const [settingId, keys] of await tabKeysBySetting()) {
    add(settingId, keys)
  }
  add('queue', await distinctKeys(agentQueueEntry))
  add('transcript', await distinctKeys(agentSessionEvent))
  add('attachments', await distinctKeys(chatAttachment))
  return stored
}

async function readOwners(): Promise<SessionKeyOwners> {
  const threads = await db.select({ key: groupChatThread.sessionKey }).from(groupChatThread)
  const aliases = await db.select({ key: groupChatThreadAlias.sessionKey }).from(groupChatThreadAlias)
  return {
    threads: new Set(threads.map((row) => row.key)),
    aliases: new Set(aliases.flatMap((row) => (row.key ? [row.key] : []))),
  }
}

/**
 * Forget every stored group-chat key no live thread owns, through the same
 * retirement a thread delete performs, or refuse and say why.
 *
 * Run by the server at start, before any request is served, so ownership is
 * classified against a store nothing is writing to. A second run finds
 * nothing to forget.
 */
export async function sweepOrphanedSessionKeys(
  owners: () => Promise<SessionKeyOwners> = readOwners,
): Promise<OrphanSweepReport> {
  const stored = await storedGroupChatKeys()
  if (stored.size === 0) {
    return { forgotten: [], aliasHeld: [], stored: 0 }
  }
  let known: SessionKeyOwners
  try {
    known = await owners()
  } catch (error) {
    return { refused: `could not read which threads own session keys (${String(error)})` }
  }
  if (known.threads.size === 0) {
    return { refused: `no thread exists while ${stored.size} group-chat key(s) are stored` }
  }
  const unowned = [...stored]
    .filter(([key]) => !known.threads.has(key))
    .map(([key, stores]): StoredKey => ({ key, stores }))
  if (unowned.length * 2 > stored.size) {
    return { refused: `${unowned.length} of ${stored.size} stored group-chat key(s) have no thread -- more than half` }
  }
  const aliasHeld = unowned.filter((entry) => known.aliases.has(entry.key))
  const forgotten = unowned.filter((entry) => !known.aliases.has(entry.key))
  for (const { key } of forgotten) {
    await forgetLocalSessionImpl(key)
  }
  return { forgotten, aliasHeld, stored: stored.size }
}

function listed(entries: StoredKey[], verb: string): string[] {
  const lines = entries.slice(0, LISTED_KEYS).map(({ key, stores }) => `  ${verb} ${key} (${stores.join(', ')})`)
  if (entries.length > LISTED_KEYS) {
    lines.push(`  (+${entries.length - LISTED_KEYS} more)`)
  }
  return lines
}

/** The log lines for a sweep: none when it found nothing to do. */
export function describeOrphanSweep(report: OrphanSweepReport): string[] {
  if ('refused' in report) {
    return [`left orphaned session keys alone: ${report.refused}`]
  }
  const lines: string[] = []
  if (report.forgotten.length > 0) {
    lines.push(`forgot ${report.forgotten.length} orphaned session key(s) of ${report.stored} stored`)
    lines.push(...listed(report.forgotten, 'forgot'))
  }
  if (report.aliasHeld.length > 0) {
    lines.push(`alias-held session state: ${report.aliasHeld.length}`)
    lines.push(...listed(report.aliasHeld, 'kept'))
  }
  return lines
}
