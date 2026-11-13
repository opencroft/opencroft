import { requireSignedInUser } from '@/app/_authed/(group-chats)/_server/model'
import { type RecentThreadView, resolveRecentThreadsView } from '@/app/_authed/(group-chats)/_server/read-model'
import {
  readLayoutRow,
  type SaveLayoutResult,
  type ThreadLayout,
  type ThreadLayoutEntry,
  threadIdsIn,
  updateLayoutRow,
  type VersionedThreadLayout,
  withoutThread,
  withoutThreads,
  withThreadsAdded,
  writeLayoutRow,
} from '@/app/_authed/(group-chats)/_server/thread-layout-store'

// The signed-in person's Recent: the threads they keep at hand on the chats
// page, in their own order and folders.
//
// It is the person's own, so it lives in the account: one settings row per
// user, keyed by the user id taken from the request and never from the
// caller's payload, so another device of theirs opens with the same list and
// nobody reaches anyone else's. The row holds the same skeleton a chat's
// thread list stores -- thread ids, folder names, order -- in the same shape,
// written by the same compare-and-swap (thread-layout-store.ts), so a drag in
// Recent is saved and refused exactly as one in a thread list is.
//
// A thread joins at the end of the top level the first time it is opened and
// is never moved by opening it again: only the person arranges it. It leaves
// only by the row's close button, or when the person can no longer read it
// (deleted, or in a chat they left), which every read below prunes.

const SETTING_PREFIX = 'group-chat-recent:'

function rowId(userId: string): string {
  return `${SETTING_PREFIX}${userId}`
}

/** Recent as the chats page draws it: the arrangement, its version, and each thread it holds as it reads now. */
export interface RecentView extends VersionedThreadLayout {
  /** Whose Recent this is: versions count one person's writes. */
  userId: string
  threads: RecentThreadView[]
}

/**
 * The arrangement with each of its threads resolved for the reader, after
 * taking out the ones they can no longer open. A thread missing from the
 * answer is only ever one the read did not return for this reader; a failed
 * read throws and prunes nothing.
 */
async function view(request: Request, userId: string, current: VersionedThreadLayout): Promise<RecentView> {
  const ids = threadIdsIn(current.layout)
  const threads = await resolveRecentThreadsView(request, ids)
  const found = new Set(threads.map((thread) => thread.id))
  const gone = ids.filter((id) => !found.has(id))
  const settled =
    gone.length > 0 ? await updateLayoutRow(rowId(userId), (layout) => withoutThreads(layout, gone)) : current
  return { ...settled, userId, threads }
}

/**
 * The reader's Recent, after adding the threads a browser kept before Recent
 * moved into the account (`legacyIds`, newest first as that browser showed
 * them). They join at the end, in that order, so the list reads as it did; a
 * thread already in Recent stays where it is, which makes a repeated import
 * from the same or another browser change nothing.
 */
export async function loadRecent(request: Request, legacyIds: readonly string[]): Promise<RecentView> {
  const { id: userId } = await requireSignedInUser(request)
  if (legacyIds.length > 0) {
    const readable = (await resolveRecentThreadsView(request, [...legacyIds])).map((thread) => thread.id)
    const current = await updateLayoutRow(rowId(userId), (layout) => withThreadsAdded(layout, readable))
    return view(request, userId, current)
  }
  return view(request, userId, await readLayoutRow(rowId(userId)))
}

/**
 * Records that the reader opened `threadId`: appended at the end of Recent the
 * first time, left where it is every other time. A thread the reader cannot
 * read is not recorded.
 */
export async function recordRecent(request: Request, threadId: string): Promise<RecentView> {
  const { id: userId } = await requireSignedInUser(request)
  const readable = await resolveRecentThreadsView(request, [threadId])
  const current =
    readable.length > 0
      ? await updateLayoutRow(rowId(userId), (layout) => withThreadsAdded(layout, [threadId]))
      : await readLayoutRow(rowId(userId))
  return view(request, userId, current)
}

/** Takes `threadId` out of the reader's Recent; a folder it leaves stays. */
export async function removeRecent(request: Request, threadId: string): Promise<RecentView> {
  const { id: userId } = await requireSignedInUser(request)
  const current = await updateLayoutRow(rowId(userId), (layout) => withoutThread(layout, threadId))
  return view(request, userId, current)
}

/**
 * Replaces the reader's arrangement, but only at the version it was based on;
 * otherwise answers with the arrangement as it stands, for the reader to take
 * (see `writeThreadLayout` on why a lost race is never retried).
 */
export async function saveRecentLayout(
  request: Request,
  layout: ThreadLayout,
  expectedVersion: number,
): Promise<SaveLayoutResult> {
  const { id: userId } = await requireSignedInUser(request)
  const version = await writeLayoutRow(rowId(userId), layout, expectedVersion)
  return version === null ? { ok: false, current: await readLayoutRow(rowId(userId)) } : { ok: true, version }
}

const isString = (value: unknown): value is string => typeof value === 'string'

function isEntry(value: unknown): value is ThreadLayoutEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Record<string, unknown>
  if (entry.kind === 'thread') {
    return isString(entry.threadId)
  }
  if (entry.kind !== 'folder' || typeof entry.folder !== 'object' || entry.folder === null) {
    return false
  }
  const folder = entry.folder as Record<string, unknown>
  return (
    isString(folder.id) && isString(folder.name) && Array.isArray(folder.threadIds) && folder.threadIds.every(isString)
  )
}

/**
 * A layout as the browser sent it, checked for the shape every reader of the
 * row relies on, since a malformed one would fail the person's Recent on each
 * device until it was overwritten.
 */
export function parseRecentLayoutInput(value: unknown): ThreadLayout {
  const entries = (value as { entries?: unknown } | null)?.entries
  if (!Array.isArray(entries) || !entries.every(isEntry)) {
    throw new Error('Expected a layout of threads and folders')
  }
  return { entries }
}
