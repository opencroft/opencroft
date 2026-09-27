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
//
// TWO LISTS PER CHAT, one row each: the active threads and the archived ones.
// Each keeps its own folders and order, so a thread moved between folders in
// the archive comes back to the folder it had there. Which list a thread is
// DRAWN in is decided by its row's `archivedAt`, never by which layout
// mentions it -- a layout is only where it sits within its list.
export type ThreadList = 'active' | 'archive'

const SETTING_PREFIX: Record<ThreadList, string> = {
  active: 'group-chat-thread-layout:',
  archive: 'group-chat-thread-archive-layout:',
}

function settingId(groupChatId: string, list: ThreadList): string {
  return `${SETTING_PREFIX[list]}${groupChatId}`
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

/**
 * Read the layout. The two below are the STORE: they take a chat id and touch
 * the settings row, and they check nothing.
 *
 * Nothing reachable from the browser may call them. A layout is per chat, and
 * the settings table is global, so an ungated write would let any signed-in
 * person rearrange -- or fill with nonsense -- the thread list of a chat they
 * are not in. The gated pair in thread-layout-access.ts is what a server
 * function calls, and the group-chat model calls `updateThreadLayout` below
 * only behind its own agent-membership gate; these stay exported because the
 * concurrency behaviour is worth testing without a signed-in session to build
 * first.
 *
 * That sentence stays true AFTER the gated pair, by a route the gate cannot
 * reach: the generic settings writes take a caller-supplied id, carry no
 * authorization of their own, and are callable endpoints regardless of which
 * page links to them. Worse for this row than a plain overwrite -- the generic
 * write does not touch `version`, so the next drag compare-and-swaps against a
 * version that is stale without looking stale, succeeds, and clobbers with no
 * refusal and no toast. That gate closes the door this file opened; it
 * cannot close one standing open beside it, and every other feature in that
 * table has the same exposure. Not this module's to fix.
 */
export async function readThreadLayout(groupChatId: string, list: ThreadList): Promise<VersionedThreadLayout> {
  const row = await getSetting(settingId(groupChatId, list))
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
 * reports, so it belongs to that component's own contract. A server-side
 * writer that HAS an operation uses `updateThreadLayout` instead.
 */
export async function writeThreadLayout(
  groupChatId: string,
  list: ThreadList,
  layout: ThreadLayout,
  expectedVersion: number,
): Promise<number | null> {
  const row = await upsertSettingCas(settingId(groupChatId, list), JSON.stringify(layout), expectedVersion)
  return row?.version ?? null
}

/** How many lost races `updateThreadLayout` absorbs before it gives up. */
export const MAX_THREAD_LAYOUT_ATTEMPTS = 5

/**
 * Apply ONE change to the layout as it stands now, re-applying it on a lost race.
 *
 * This is the retry `writeThreadLayout` warns against, made safe by what is
 * retried: not a tree built before somebody else's write, but the change
 * itself, run again against a fresh read. Whatever the other writer did -- a
 * member's drag, another agent's placement -- is in that read, so it survives,
 * and the change lands on top of it. Every write is still the same
 * compare-and-swap, so a person's drag based on the older version is refused
 * and re-read on their side exactly as it would be against another person.
 *
 * `change` returns `null` when the layout already says what it wants, and
 * nothing is written. It may run more than once, so it must be a pure function
 * of the layout it is handed.
 *
 * Throws after `MAX_THREAD_LAYOUT_ATTEMPTS` lost races rather than looping: a
 * list rewritten that often in a row is contended by something other than
 * people, and a bounded refusal says so where an unbounded loop would hang.
 *
 * `read` is replaceable so a test can land a competing write between the read
 * and the write -- the window this exists for -- deterministically, against
 * the real store.
 */
export async function updateThreadLayout(
  groupChatId: string,
  list: ThreadList,
  change: (layout: ThreadLayout) => ThreadLayout | null,
  read: (groupChatId: string, list: ThreadList) => Promise<VersionedThreadLayout> = readThreadLayout,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_THREAD_LAYOUT_ATTEMPTS; attempt++) {
    const current = await read(groupChatId, list)
    const next = change(current.layout)
    if (!next) {
      return
    }
    if ((await writeThreadLayout(groupChatId, list, next, current.version)) !== null) {
      return
    }
  }
  throw new Error(`The thread list changed ${MAX_THREAD_LAYOUT_ATTEMPTS} times while it was being written; try again`)
}

// ── Folders, by the name a person sees ───────────────────────────────────
//
// An agent names a folder the way a person reads it off the list, so these
// work on names. The folder id stays what the list component keys on and is
// never shown.

/**
 * The layout with `threadId` filed at the end of the folder named `folderName`,
 * or `null` when it is already in that folder.
 *
 * The thread is taken out of wherever it was first -- top level or another
 * folder -- so it appears once. The first folder with exactly that name takes
 * it; with none, a folder is created the way the list's own "Move to new
 * folder" creates one: open, after the last folder. A folder the thread leaves
 * is kept even when empty, as it is after a person drags its last thread out.
 */
export function withThreadInFolder(layout: ThreadLayout, threadId: string, folderName: string): ThreadLayout | null {
  const target = layout.entries.find(
    (entry): entry is Extract<ThreadLayoutEntry, { kind: 'folder' }> =>
      entry.kind === 'folder' && entry.folder.name === folderName,
  )
  if (target?.folder.threadIds.includes(threadId)) {
    return null
  }
  const entries: ThreadLayoutEntry[] = (withoutThread(layout, threadId) ?? layout).entries.map((entry) =>
    entry.kind === 'folder' && entry.folder.id === target?.folder.id
      ? { kind: 'folder', folder: { ...entry.folder, threadIds: [...entry.folder.threadIds, threadId] } }
      : entry,
  )
  if (!target) {
    const lastFolder = entries.findLastIndex((entry) => entry.kind === 'folder')
    entries.splice(lastFolder + 1, 0, {
      kind: 'folder',
      folder: { id: unusedFolderId(layout), name: folderName, open: true, threadIds: [threadId] },
    })
  }
  return { entries }
}

/**
 * The layout with `threadId` filed in the folder named `folderName`, or loose at
 * the end of the top level when `folderName` is null; `null` when it is already
 * there. What moving a thread between the active list and the archive does to
 * the list it arrives in: it keeps the folder it had by name, and a folder the
 * arriving list does not have is created.
 */
export function withThreadPlaced(
  layout: ThreadLayout,
  threadId: string,
  folderName: string | null,
): ThreadLayout | null {
  if (folderName !== null) {
    return withThreadInFolder(layout, threadId, folderName)
  }
  if (layout.entries.some((entry) => entry.kind === 'thread' && entry.threadId === threadId)) {
    return null
  }
  return { entries: [...(withoutThread(layout, threadId) ?? layout).entries, { kind: 'thread', threadId }] }
}

/**
 * The layout with `threadId` taken out of wherever it is, or `null` when it is
 * not there. A folder it leaves is kept even when empty, as with a drag.
 */
export function withoutThread(layout: ThreadLayout, threadId: string): ThreadLayout | null {
  if (
    !folderNameByThreadId(layout).has(threadId) &&
    !layout.entries.some((entry) => entry.kind === 'thread' && entry.threadId === threadId)
  ) {
    return null
  }
  return {
    entries: layout.entries
      .filter((entry) => entry.kind === 'folder' || entry.threadId !== threadId)
      .map((entry) =>
        entry.kind === 'thread'
          ? entry
          : {
              kind: 'folder',
              folder: { ...entry.folder, threadIds: entry.folder.threadIds.filter((id) => id !== threadId) },
            },
      ),
  }
}

/** Same id scheme as the list component's, skipping any the layout holds. */
function unusedFolderId(layout: ThreadLayout): string {
  const taken = new Set(layout.entries.flatMap((entry) => (entry.kind === 'folder' ? [entry.folder.id] : [])))
  let n = 1
  while (taken.has(`folder-${n}`)) {
    n++
  }
  return `folder-${n}`
}

/** The name of the folder each filed thread is in. A top-level thread has no entry. */
export function folderNameByThreadId(layout: ThreadLayout): Map<string, string> {
  return new Map(
    layout.entries.flatMap((entry) =>
      entry.kind === 'folder' ? entry.folder.threadIds.map((id) => [id, entry.folder.name] as const) : [],
    ),
  )
}
