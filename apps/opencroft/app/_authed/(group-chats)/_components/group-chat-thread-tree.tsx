'use client'

import { ChatList, type ChatListNode } from 'ui/chat/chat-list'

import type { ThreadRowStateById } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import { layoutToNodes } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import type { GroupChatThreadEntry, ThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'

interface GroupChatThreadTreeProps {
  threads: GroupChatThreadEntry[]
  /** Live process state and context reading per thread -- see useThreadRowStates. */
  stateById: ThreadRowStateById
  /** The arrangement to draw. Owned by the caller -- see `useThreadLayout`. */
  layout: ThreadLayout
  onChange: (nodes: ChatListNode[]) => void
  activeId?: string
  onSelect: (threadId: string) => void
  // Omitted where a row action makes no sense for the list being drawn -- the
  // chat's own archive draws this same tree read-only apart from Unarchive,
  // and passes none of the three below.
  onRename?: (threadId: string) => void
  onStopProcess?: (threadId: string) => void
  onDelete?: (threadId: string) => void
  // Mutually exclusive: the active list offers Archive, the chat's own archive
  // offers Unarchive, and neither list offers both.
  onArchive?: (threadId: string) => void
  onUnarchive?: (threadId: string) => void
  className?: string
}

// One group chat's threads as a foldered, reorderable list.
//
// The list is the kit's ChatList, unchanged and unwrapped -- the same
// component, the same gestures and the same timings the sidebar's chat list has
// always had. All this adds is the one thing the kit cannot know: how a thread
// becomes a row.
//
// It holds no state. The arrangement belongs to whoever mounts this, because
// the same one is drawn both on the chat's screen and in the sidebar, and a
// copy in each would drift apart the first time either was dragged.
export function GroupChatThreadTree({
  threads,
  stateById,
  layout,
  onChange,
  activeId,
  onSelect,
  onRename,
  onStopProcess,
  onDelete,
  onArchive,
  onUnarchive,
  className,
}: GroupChatThreadTreeProps) {
  return (
    <ChatList
      nodes={layoutToNodes(layout, threads, stateById)}
      activeId={activeId}
      onSelect={onSelect}
      onRename={onRename}
      onStopProcess={onStopProcess}
      onDelete={onDelete}
      onArchive={onArchive}
      onUnarchive={onUnarchive}
      onChange={onChange}
      className={className}
    />
  )
}
