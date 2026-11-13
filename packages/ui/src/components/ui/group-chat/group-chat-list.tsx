'use client'

import type { ReactNode } from 'react'
import { Pencil } from 'lucide-react'

import { ListEmpty } from 'ui/components/ui/utils/list-empty'
import { ListRow } from 'ui/components/ui/utils/list-row'
import { MemberAvatarGroup, type MemberRef } from 'ui/components/ui/group-chat/member-avatar-group'
import { RowContextMenu } from 'ui/components/ui/utils/row-context-menu'
import { cn } from 'cn'

export interface GroupChatListItem {
  id: string
  /** What the chat is called. NOT its topic -- a group chat has both, and the
   * topic is the statement of purpose its agents are given, which is not a
   * list subtitle. See group-chat-detail. */
  name: string
  members: MemberRef[]
  threadCount: number
  /** The section the chat is listed in, such as Channels for the spaces' own
   * chats. Chats sharing a group are listed together under its name, the
   * list's `groups` first and the rest in the order their first chat arrives
   * in; chats with none come last, under `ungroupedLabel`. When no chat has a
   * group and no `groups` are given the list is flat. */
  group?: { id: string; name: string }
}

/** A section the list always shows, with or without chats in it. */
export interface GroupChatListGroup {
  id: string
  name: string
  /** Drawn at the end of the section's heading row, such as the button that
   * creates a chat. */
  action?: ReactNode
}

export interface GroupChatListRowProps {
  id: string
  name: string
  members: MemberRef[]
  threadCount: number
  active?: boolean
  onSelect?: (id: string) => void
  /** Per-row delete, on the same shadcn context-menu primitive a chat row and a
     thread row already use -- same icon, same wording, same destructive
     styling, so deleting a container is reached the same way as deleting a
     thread inside it rather than through an affordance of its own.

     The kit does not confirm, exactly as ChatListItem does not: whether a
     delete is worth confirming, and what the confirmation says, depends on what
     is being destroyed and how much of it -- which is the host's knowledge, not
     this list's. Omit the handler and no menu appears at all. */
  onDelete?: (id: string) => void
  /** Per-row rename, in the same menu. The row reports the id and stops there:
     renaming can be refused, so the host's dialog is where the new name is
     collected and where a refusal has somewhere to be shown. This is where a
     chat is renamed -- its own screen no longer carries an editable title. */
  onRename?: (id: string) => void
}

function threadLabel(n: number) {
  return `${n} ${n === 1 ? 'thread' : 'threads'}`
}

// A group-chat row. It IS the chat row's shell -- both draw ListRow, so the
// geometry and the feel are the same object rather than two that match. What
// this row contributes is what goes in the leading slot, and what deliberately
// does not exist: a group chat is a *container* with several members, so the
// leading element is a cluster of participant avatars rather than a single one,
// and there is NO process status -- offline / idle / working describe an agent
// process and mean nothing for a container.
//
// Moving onto the shared shell also brings this row the touch handling it did
// not carry: the shell holds `touch-action: pan-y` and suppresses the native
// long-press text behaviour, which is what leaves a long press free to reach
// the context menu below. A chat row has had that for a while; this one had
// none of it, on the same geometry.
//
// Name is the title; threadCount is the secondary line -- the topic is not
// shown here at all, see the note in the docs.
export function GroupChatListRow({
  id,
  name,
  members,
  threadCount,
  active = false,
  onSelect,
  onDelete,
  onRename,
}: GroupChatListRowProps) {
  const row = (
    <ListRow
      leading={<MemberAvatarGroup members={members} max={3} size='sm' />}
      title={name}
      secondary={threadLabel(threadCount)}
      active={active}
      onSelect={() => onSelect?.(id)}
    />
  )

  // The menu is row-context-menu, the same component ChatListItem's row uses.
  // This used to be a copy of it, and the comment here used to say so -- the
  // width, the click guard and the destructive Delete were maintained in two
  // files that promised each other they matched.
  //
  // No handler, no menu: with both omitted the menu component returns the
  // row untouched, so a host that offers neither pays nothing for the option.
  return (
    <RowContextMenu
      entries={onRename ? [{ key: 'rename', label: 'Rename', icon: <Pencil />, onSelect: () => onRename(id) }] : undefined}
      onDelete={onDelete ? () => onDelete(id) : undefined}
    >
      {row}
    </RowContextMenu>
  )
}

export interface GroupChatListProps {
  chats: GroupChatListItem[]
  activeId?: string
  onSelect?: (id: string) => void
  /** Sections listed first and in this order, each under its heading even
   * while no chat is in it, so a heading's action is there in the empty state
   * too. A chat names one through its `group` id. */
  groups?: GroupChatListGroup[]
  /** Per-row delete, forwarded to every row's context menu. See the row's own
     prop for why the confirmation is the host's and not this list's. */
  onDelete?: (id: string) => void
  /** Per-row rename, forwarded to every row's context menu. The host's dialog
     collects the name; this is where a chat is renamed. */
  onRename?: (id: string) => void
  emptyState?: ReactNode
  /** The heading over the chats that have no group, once any chat has one. */
  ungroupedLabel?: string
  className?: string
}

/** A heading over one section of a sidebar list: a group of chats here, and
 * the other sections the chats page stacks under the list (Recent). Exported so
 * those draw the same line rather than a matching one. `action` sits at the
 * row's far end; its margin keeps a small icon button from making the row
 * taller than the text. */
export function GroupChatListHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className='flex min-w-0 items-center gap-1 px-2 pt-3 pb-1'>
      <h3 className='min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground'>{children}</h3>
      {action ? <div className='-my-1 shrink-0'>{action}</div> : null}
    </div>
  )
}

interface ChatSection {
  key: string
  name: string | null
  action?: ReactNode
  chats: GroupChatListItem[]
}

// The given groups, then the other groups in the order their first chat
// appears, then the chats with none. One unnamed section when there are no
// groups at all, so a flat list stays flat.
function sectionsOf(chats: GroupChatListItem[], groups: GroupChatListGroup[], ungroupedLabel: string): ChatSection[] {
  if (groups.length === 0 && !chats.some((chat) => chat.group)) {
    return chats.length > 0 ? [{ key: '', name: null, chats }] : []
  }
  const sections = new Map<string, ChatSection>(
    groups.map((group) => [
      group.id,
      { key: `group:${group.id}`, name: group.name, action: group.action, chats: [] },
    ]),
  )
  const ungrouped: GroupChatListItem[] = []
  for (const chat of chats) {
    if (!chat.group) {
      ungrouped.push(chat)
      continue
    }
    const section = sections.get(chat.group.id)
    if (section) {
      section.chats.push(chat)
    } else {
      sections.set(chat.group.id, { key: `group:${chat.group.id}`, name: chat.group.name, chats: [chat] })
    }
  }
  const result = [...sections.values()]
  if (ungrouped.length > 0) {
    result.push({ key: 'ungrouped', name: ungroupedLabel, chats: ungrouped })
  }
  return result
}

// The section index: every group chat the signed-in user is a member of. A list
// of containers, under their groups' headings when they name one -- no
// folders, no drag handle (those belong to the existing chat list); group
// chats are their own navigation section, separate from Chats, and reordering
// is additive later if it is wanted.
//
// Creating one lives on a heading, through a group's `action`. It sits with
// the list rather than on a route of its own because the list is also what a
// person with no group chats sees: put creation anywhere else and the empty
// state is a dead end. A given group's heading is drawn in both states, so it
// never moves.
export function GroupChatList({
  chats,
  activeId,
  onSelect,
  groups = [],
  onDelete,
  onRename,
  emptyState,
  ungroupedLabel = 'Other chats',
  className,
}: GroupChatListProps) {
  return (
    <div className={cn('flex w-full min-w-0 flex-col', className)}>
      {sectionsOf(chats, groups, ungroupedLabel).map((section) => (
        <section key={section.key} className='flex w-full min-w-0 flex-col'>
          {section.name ? (
            <GroupChatListHeading action={section.action}>{section.name}</GroupChatListHeading>
          ) : null}
          <div className='flex w-full min-w-0 flex-col gap-0.5'>
            {section.chats.map((chat) => (
              <GroupChatListRow
                key={chat.id}
                id={chat.id}
                name={chat.name}
                members={chat.members}
                threadCount={chat.threadCount}
                active={chat.id === activeId}
                onSelect={onSelect}
                onDelete={onDelete}
                onRename={onRename}
              />
            ))}
          </div>
        </section>
      ))}

      {/* The default line is ListEmpty, a shared primitive from the
          BaseComponents kit rather than a sentence spelled out here. Six lists
          wrote their own before it existed and drifted five ways -- what varied
          was never the words, which are the host's, but the padding, the type
          size and whether it was centred at all. */}
      {chats.length === 0 ? (emptyState ?? <ListEmpty text='No group chats yet.' size='xs' />) : null}
    </div>
  )
}
