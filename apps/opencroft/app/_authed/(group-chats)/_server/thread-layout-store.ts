import { getSetting, upsertSettingCas } from '@/server/data'

// Folder structure and order for ONE group chat's thread list.
//
// Shared between that chat's members rather than kept per person: a group
// chat's threads are one thing everybody is looking at, so a folder one member
// makes is a folder everyone sees. The settings row is global, which is what
// makes that the cheap option -- and also what makes the concurrency below a
// real case rather than a theoretical one.
//
// Only the SKELETON is stored: thread ids, folder names, and order. A thread's
// title, its agent and its live status are read from the thread rows on every
// load, so nothing here can go stale against a rename or a departed agent.
const SETTING_PREFIX = 'group-chat-thread-layout:'

function settingId(groupChatId: string): string {
  return `${SETTING_PREFIX}${groupChatId}`
}

export interface ThreadLayoutFolder {
  id: string
  name: string
  open?: boolean
  threadIds: string[]
}

export type ThreadLayoutEntry = { kind: 'thread'; threadId: string } | { kind: 'folder'; folder: ThreadLayoutFolder }

export interface ThreadLayout {
  entries: ThreadLayoutEntry[]
}

/**
 * A layout and the row version it was read at.
 *
 * The version travels with the layout because a writer has to hand back the
 * version it based its tree on -- see `writeThreadLayout`. Returning it here,
 * rather than making the caller ask for it separately, is what stops a caller
 * writing against a version it never actually read.
 */
export interface VersionedThreadLayout {
  layout: ThreadLayout
  version: number
}

const EMPTY_LAYOUT: ThreadLayout = { entries: [] }

function parseLayout(raw: string): ThreadLayout {
  // A corrupt row degrades to an empty layout rather than failing the read: the
  // client already treats an empty layout as "nothing arranged yet", and a
  // group chat whose threads will not list at all is a worse outcome than one
  // whose folders are gone.
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadLayout>
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] }
  } catch {
    return EMPTY_LAYOUT
  }
}

export async function readThreadLayout(groupChatId: string): Promise<VersionedThreadLayout> {
  const row = await getSetting(settingId(groupChatId))
  if (!row) {
    // Version 0 is "no row yet", which is what upsertSettingCas expects from a
    // first writer -- so an unarranged chat and an arranged one are written the
    // same way, with no separate create path.
    return { layout: EMPTY_LAYOUT, version: 0 }
  }
  return { layout: parseLayout(row.data), version: row.version }
}

/**
 * Replace the layout, but only if nobody else has written since it was read.
 *
 * Returns the new version on success and `null` when another member got there
 * first. The caller re-reads and re-renders; it must NOT retry with the same
 * tree.
 *
 * The retry is the tempting move and it is wrong. What arrives here is the
 * WHOLE list, not the operation that changed it, so a tree built before
 * someone else's write already has their change missing from it. Re-applying
 * that tree at the newer version is the same lost update the version check
 * exists to prevent, performed deliberately. Losing a race has to end in a
 * re-read, which is why this returns null instead of looping.
 *
 * Persisting the operation instead of the whole tree would remove the conflict
 * rather than detect it, but that is a change to what the list component
 * reports, so it belongs to that component's own contract.
 */
export async function writeThreadLayout(
  groupChatId: string,
  layout: ThreadLayout,
  expectedVersion: number,
): Promise<number | null> {
  const row = await upsertSettingCas(settingId(groupChatId), JSON.stringify(layout), expectedVersion)
  return row?.version ?? null
}
