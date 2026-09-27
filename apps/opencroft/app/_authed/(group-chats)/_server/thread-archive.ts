import { db, groupChatThread } from '@opencroft/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { clearQueueLocalImpl } from '@/app/_authed/(agent)/_server/acp-impl'
import {
  folderNameByThreadId,
  readThreadLayout,
  type ThreadList,
  updateThreadLayout,
  withoutThread,
  withThreadPlaced,
} from '@/app/_authed/(group-chats)/_server/thread-layout-store'

// Archiving a thread: the move itself, behind whichever gate called it.
//
// An archived thread keeps its row, its session and its history. It leaves the
// chat's active list for the archive list, and the delivery path refuses every
// send into it (see the model's `deliverIntoThread`). Nothing here checks who
// is asking -- every caller has already answered that for its own principal.

/** The columns the move needs off a thread row. */
export interface ArchivableThread {
  id: string
  groupChatId: string
  sessionKey: string
}

/** The list a thread is drawn in, from its row. */
export function threadListOf(thread: { archivedAt: Date | null }): ThreadList {
  return thread.archivedAt ? 'archive' : 'active'
}

/**
 * Archive (`archived: true`) or unarchive a thread. A thread already in that
 * state is left exactly as it is, so a repeated call changes nothing.
 *
 * The row's `archivedAt` is written FIRST and decides which list the thread is
 * drawn in; the two layouts only say where it sits within its list. So a move
 * interrupted between the writes below still shows the thread in the right
 * list -- at worst loose at the end of it, which is where a list puts a thread
 * its layout does not mention.
 *
 * The thread keeps its folder across the move, by name: it arrives in the
 * folder of the same name in the other list, which is created when that list
 * has none, or loose at the top level when it had no folder.
 *
 * Archiving also drops whatever was waiting in the thread's queue. Those
 * messages were accepted before the thread closed and would otherwise be
 * delivered after it; a turn already running is left to finish.
 */
export async function moveThreadBetweenLists(thread: ArchivableThread, archived: boolean): Promise<void> {
  const [moved] = await db
    .update(groupChatThread)
    .set({ archivedAt: archived ? new Date() : null })
    .where(
      and(
        eq(groupChatThread.id, thread.id),
        archived ? isNull(groupChatThread.archivedAt) : isNotNull(groupChatThread.archivedAt),
      ),
    )
    .returning({ id: groupChatThread.id })
  if (!moved) {
    return
  }
  if (archived) {
    await clearQueueLocalImpl(thread.sessionKey)
  }
  const from: ThreadList = archived ? 'active' : 'archive'
  const to: ThreadList = archived ? 'archive' : 'active'
  const folder = folderNameByThreadId((await readThreadLayout(thread.groupChatId, from)).layout).get(thread.id) ?? null
  await updateThreadLayout(thread.groupChatId, to, (layout) => withThreadPlaced(layout, thread.id, folder))
  await updateThreadLayout(thread.groupChatId, from, (layout) => withoutThread(layout, thread.id))
}
