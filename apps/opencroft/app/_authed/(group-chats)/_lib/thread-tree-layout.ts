import type { ChatListLeaf, ChatListNode } from 'ui/chat/chat-list'
import type { ChatStatus } from 'ui/chat/chat-list-item'

import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/read-model'
import type {
  ThreadLayout,
  ThreadLayoutEntry,
  VersionedThreadLayout,
} from '@/app/_authed/(group-chats)/_server/thread-layout-store'

// Between the saved layout and the live threads.
//
// The layout stores a skeleton -- thread ids, folder names, order -- and the
// threads arrive from the server on every load. Everything interesting here is
// what happens where the two disagree: a thread the layout has never seen, and
// a layout entry whose thread is gone.

/** A thread's live process state, keyed by thread id. */
export type ThreadStatusById = ReadonlyMap<string, ChatStatus>

/**
 * A chat nobody has arranged, at the version a first write expects.
 *
 * Also what a screen stands in with when its load refused, so the hooks that
 * take a layout still run on every render rather than only when there is one.
 */
export const EMPTY_THREAD_LAYOUT: VersionedThreadLayout = { layout: { entries: [] }, version: 0 }

/**
 * One thread as a row.
 *
 * The three decisions below are not this module's; they were made for the
 * thread list this replaces, and they are carried across deliberately rather
 * than re-derived.
 */
export function threadLeaf(thread: GroupChatThreadEntry, status: ChatStatus | undefined): ChatListLeaf {
  // The server states membership; turning that into a dimmed row is the
  // screen's business, which is why the entry carries `agentIsMember` and not
  // `disabled`.
  const removed = !thread.agentIsMember
  return {
    id: thread.id,
    title: thread.title ?? 'Untitled',
    description: removed ? `${thread.agent.name} · agent removed` : thread.agent.name,
    // A removed agent's thread is never given a state, whatever its session is
    // doing. The row is dimmed already, sending is blocked regardless of what a
    // dot would say, and "agent removed" is the fact that governs what the
    // reader can do next -- a second state beside it would only make the row
    // argue with itself.
    status: removed ? undefined : status,
    avatarUrl: thread.agent.avatarUrl,
    hasDraft: thread.hasDraft,
    disabled: removed,
  }
}

/**
 * The tree to render: the saved arrangement, filled in from the live threads.
 *
 * A layout entry whose thread no longer exists is dropped, and a thread the
 * layout does not mention joins the loose list at the end in the server's
 * order. Together those mean an unarranged chat and an arranged one take the
 * same path: an empty layout renders every thread loose, so nothing has to
 * write a layout before a list can be shown.
 */
export function layoutToNodes(
  layout: ThreadLayout,
  threads: GroupChatThreadEntry[],
  statusById: ThreadStatusById,
): ChatListNode[] {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const placed = new Set<string>()
  const nodes: ChatListNode[] = []

  const leafFor = (threadId: string): ChatListLeaf | null => {
    const thread = byId.get(threadId)
    if (!thread) {
      return null
    }
    placed.add(threadId)
    return threadLeaf(thread, statusById.get(threadId))
  }

  for (const entry of layout.entries) {
    if (entry.kind === 'thread') {
      const leaf = leafFor(entry.threadId)
      if (leaf) {
        nodes.push({ type: 'item', item: leaf })
      }
      continue
    }
    // A folder left empty by deletions is KEPT. It is something a person made
    // and named; removing it because its last thread went would take away a
    // place they can drag the next one into, without anyone having asked.
    const items = entry.folder.threadIds.map(leafFor).filter((leaf) => leaf !== null)
    nodes.push({
      type: 'folder',
      folder: { id: entry.folder.id, name: entry.folder.name, open: entry.folder.open, items },
    })
  }

  for (const thread of threads) {
    if (!placed.has(thread.id)) {
      nodes.push({ type: 'item', item: threadLeaf(thread, statusById.get(thread.id)) })
    }
  }
  return nodes
}

/**
 * The tree back to a layout, keeping only the skeleton.
 *
 * This is the half that makes the store's "nothing here can go stale" claim
 * true: titles, avatars, status and draft flags are all dropped on the way in,
 * so a rename or a departed agent cannot leave a wrong copy behind in a
 * settings row.
 */
export function nodesToLayout(nodes: ChatListNode[]): ThreadLayout {
  return {
    entries: nodes.map(
      (node): ThreadLayoutEntry =>
        node.type === 'item'
          ? { kind: 'thread', threadId: node.item.id }
          : {
              kind: 'folder',
              folder: {
                id: node.folder.id,
                name: node.folder.name,
                open: node.folder.open,
                threadIds: node.folder.items.map((item) => item.id),
              },
            },
    ),
  }
}
