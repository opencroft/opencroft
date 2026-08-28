'use client'

import { ChatList, type ChatListNode } from 'ui/chat/chat-list'

import { layoutToNodes, type ThreadStatusById } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import type { GroupChatThreadEntry, ThreadLayout } from '@/app/_authed/(group-chats)/_server/actions'

interface GroupChatThreadTreeProps {
  threads: GroupChatThreadEntry[]
  /** Live process state per thread, from the shared session-activity poll. */
  statusById: ThreadStatusById
  /** The arrangement to draw. Owned by the caller -- see `useThreadLayout`. */
  layout: ThreadLayout
  onChange: (nodes: ChatListNode[]) => void
  activeId?: string
  onSelect: (threadId: string) => void
  onRename: (threadId: string) => void
  onStopProcess: (threadId: string) => void
  onDelete: (threadId: string) => void
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
  statusById,
  layout,
  onChange,
  activeId,
  onSelect,
  onRename,
  onStopProcess,
  onDelete,
  className,
}: GroupChatThreadTreeProps) {
  return (
    <ChatList
      nodes={layoutToNodes(layout, threads, statusById)}
      activeId={activeId}
      onSelect={onSelect}
      onRename={onRename}
      onStopProcess={onStopProcess}
      onDelete={onDelete}
      onChange={onChange}
      className={className}
    />
  )
}
