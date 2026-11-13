'use client'

import { ChatList, type ChatListLeaf, type ChatListNode } from 'ui/components/ui/chat/chat-list'
import type { ChatContextUsage, ChatStatus } from 'ui/components/ui/chat/chat-list-item'
import { GroupChatListHeading } from 'ui/components/ui/group-chat/group-chat-list'
import { ListEmpty } from 'ui/components/ui/utils/list-empty'
import { cn } from 'cn'

export interface RecentThread {
  id: string
  /** The thread's own title; empty reads as "Thread", as in the thread's header. */
  title?: string | null
  /** The NAME of the group chat the thread is in, shown before the title as in the thread's header. */
  groupChatName: string
  /** The one agent the thread is with. */
  agent: { name: string; avatarUrl?: string | null }
  /** What the thread's agent is doing, in the chat list rows' vocabulary. Omitted, the agent's name stands alone. */
  status?: ChatStatus
  /** How much context the thread's session holds. Omitted, no reading is drawn. */
  context?: ChatContextUsage
  /** The thread has unsent composer text. */
  hasDraft?: boolean
}

/** One thread as a Recent row: the detailed title `Chat / Thread`, and the agent's name and avatar. */
export function recentThreadLeaf(thread: RecentThread): ChatListLeaf {
  return {
    id: thread.id,
    title: thread.title || 'Thread',
    breadcrumb: thread.groupChatName,
    description: thread.agent.name,
    avatarUrl: thread.agent.avatarUrl,
    avatarName: thread.agent.name,
    status: thread.status,
    context: thread.context,
    hasDraft: thread.hasDraft,
  }
}

export interface RecentThreadsProps {
  /** The section's threads and folders, in the host's order: this section
   * neither sorts nor limits. Each thread row is `recentThreadLeaf(thread)`. */
  nodes: ChatListNode[]
  /** The thread open beside the sidebar, marked as the current row. */
  activeId?: string
  onSelect?: (id: string) => void
  /** Takes the thread out of Recent, from the close button at the row's end.
   * Omitted, rows have no close button. The thread itself is untouched. */
  onRemove?: (id: string) => void
  /** The arrangement after a drag, a new folder, or a folder renamed or
   * deleted -- the whole tree, as Chat List reports it. */
  onChange?: (nodes: ChatListNode[]) => void
  /** A folder was opened or closed -- see Chat List. */
  onFolderOpenChange?: (folderId: string, open: boolean) => void
  /** The section's heading. */
  title?: string
  /** The line shown when there are no threads yet. */
  emptyText?: string
  className?: string
}

// A section of the chats sidebar, under the chat list: the threads a person
// keeps at hand, so getting back to a conversation does not mean finding its
// chat first.
//
// The list is the Chat List a chat's own thread list is, so Recent arranges
// the same way: folders, drag to reorder and into or out of a folder, the row
// and folder menus, and on touch the same long press that picks a row up or
// opens its menu while a move scrolls. A row is the same chat list row too:
// the agent's avatar with the status dot, "Agent · Status", the context
// reading and the draft mark. Recent mixes threads from many chats, so the
// title is the detailed one, `Chat / Thread`, which is also how the thread's
// own header names it. Recent is a list of open items, like tabs, so with
// `onRemove` each row ends in the row's close button.
//
// The heading is the chat list's own, so the sections of one sidebar read as
// one list of sections. The empty line stays under it: a Recent section that
// vanishes when empty leaves no hint that it exists.
export function RecentThreads({
  nodes,
  activeId,
  onSelect,
  onRemove,
  onChange,
  onFolderOpenChange,
  title = 'Recent',
  emptyText = 'Threads you open appear here.',
  className,
}: RecentThreadsProps) {
  return (
    <section className={cn('flex w-full min-w-0 flex-col', className)}>
      <GroupChatListHeading>{title}</GroupChatListHeading>
      {nodes.length === 0 ? (
        <ListEmpty text={emptyText} size='xs' />
      ) : (
        <ChatList
          nodes={nodes}
          activeId={activeId}
          onSelect={onSelect}
          onClose={onRemove}
          closeLabel='Remove from Recent'
          onChange={onChange}
          onFolderOpenChange={onFolderOpenChange}
        />
      )}
    </section>
  )
}
