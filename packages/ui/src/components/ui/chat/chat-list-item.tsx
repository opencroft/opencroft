'use client'

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Archive, ArchiveRestore, Pencil, Square, X } from 'lucide-react'
import { ContextReading } from 'agent-chat/components/context-ring'

import { Button } from 'ui/components/ui/button'
import { cn } from 'cn'

import { AgentAvatar } from '../media/agent-avatar'
import { ListRow, ListRowContent } from '../utils/list-row'
import { RowContextMenu, type RowMenuEntry } from '../utils/row-context-menu'
import type { StatusVariant } from '../utils/status-indicator'

export interface ChatListItemAction {
  label: string
  onSelect: (id: string) => void
  icon?: ReactNode
  destructive?: boolean
}

// The row's process state. A single `status` drives BOTH the status word shown
// in the description line and the status dot, so they can never disagree.
export type ChatStatus = 'offline' | 'idle' | 'queued' | 'working' | 'waiting'

// How much context the row's session holds. `contextLimit` is null when the
// harness names no window; `asOf` is present only on a last-known reading.
export interface ChatContextUsage {
  usedTokens: number
  contextLimit: number | null
  asOf?: number
}

// What a row says about its session, and all a header naming the same session
// says: see ChatItemSummary.
interface ChatItemSummaryFields {
  title: string
  // Where the item lives, shown before the title as `breadcrumb / title`: the
  // detailed title, for a list that mixes items from several places (Recent's
  // threads, each in its own chat) and for the header of the thread such a row
  // opens. Omitted, the title stands alone.
  breadcrumb?: string
  description?: string
  status?: ChatStatus
  avatarUrl?: string | null
  // The name the avatar's fallback initial is taken from when it has no
  // image; the title when omitted. A row whose avatar is its agent's passes
  // the agent's name.
  avatarName?: string
}

interface ChatListItemProps extends ChatItemSummaryFields {
  id: string
  active?: boolean
  // Dim the row without hiding it. Used for a group-chat thread whose agent
  // has been removed: the conversation stays readable, the row just reads as
  // inactive. Selection still fires -- the content is visible, only acting on
  // it (sending) is gated elsewhere.
  disabled?: boolean
  // Drawn at the row's end, so a session near its limit shows before it is
  // opened. Absent draws nothing -- unknown is not zero.
  context?: ChatContextUsage
  hasDraft?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onStopProcess?: (id: string) => void
  // Closes the item from a button at the row's end, for a list of open items
  // such as Recent, where a row is closed as a tab is. Omitted, the row has no
  // close button.
  onClose?: (id: string) => void
  // The close button's accessible name and tooltip.
  closeLabel?: string
  // Archive and unarchive are mutually exclusive on any one row -- a row is
  // either in the active list (offered Archive) or the archive (offered
  // Unarchive), never both -- so a host passes at most one. Positioned last,
  // immediately before Delete: the two are the row's other lifecycle moves.
  onArchive?: (id: string) => void
  onUnarchive?: (id: string) => void
  onDelete?: (id: string) => void
  actions?: ChatListItemAction[]
  // Forwarded to the shared row shell, where it lands on the row element
  // itself -- the earliest point at which a host learns which input is driving
  // the row. See ListRow.
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
}

// The description line carries the process state as text, and a status dot is
// shown only for the states where something is pending. `status` derives both:
//   offline  -> no process             -> "Offline",   no dot
//   idle     -> process alive, nothing -> "Idle",      no dot
//   queued   -> no turn, messages held -> "Queued",    amber (warning) dot
//               for a later one
//   working  -> active turn            -> "Working",   green (success) dot
//   waiting  -> needs someone          -> "Needs you", blue (primary) dot
//               (a permission to grant or a question to answer)
// Idle is the state the others exist to set apart: a session with nothing to
// do looks exactly like one hard at work unless the row says which it is.
// The concrete dot colours live in the shared status-indicator primitive.
//
// Exported because this row's status line is THE vocabulary for a session's
// process state, and other surfaces (the thread framing's header) say the
// same thing about the same session -- importing these is what keeps a word
// and a dot from drifting between a list row and the header a press on it
// opens.
export const STATUS_WORD: Record<ChatStatus, string> = {
  offline: 'Offline',
  idle: 'Idle',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Needs you',
}
// A dot is shown only where something is pending; offline/idle rely on the text.
export const STATUS_DOT: Partial<Record<ChatStatus, StatusVariant>> = {
  queued: 'warning',
  working: 'success',
  waiting: 'primary',
}

// The row's content in the shape ListRow takes: the avatar wearing the status
// dot, the title (detailed when there is a breadcrumb), and "Name · Status".
// One function, so a row and the header naming the same session cannot compose
// it two ways.
function summaryContent({ title, breadcrumb, description, status, avatarUrl, avatarName }: ChatItemSummaryFields) {
  const statusWord = status ? STATUS_WORD[status] : undefined
  return {
    leading: <AgentAvatar avatar={avatarUrl} name={avatarName ?? title} statusIndicator={status ? STATUS_DOT[status] : undefined} />,
    title: breadcrumb ? `${breadcrumb} / ${title}` : title,
    // "Name · Status" when both are present; either alone otherwise; nothing
    // when neither is set.
    secondary: description && statusWord ? `${description} · ${statusWord}` : (description ?? statusWord),
  }
}

export interface ChatItemSummaryProps extends ChatItemSummaryFields {
  className?: string
}

// The base a chat list row and the header of the conversation it opens share:
// the row's content without the row -- no press, no menu, no draft, context or
// close. The thread framing and the dock window draw it in their headers, so a
// row and the header a press on it opens are one element in one type, not two
// that match. A flex row that owns no border or padding; a host may let it grow.
export function ChatItemSummary({ className, ...fields }: ChatItemSummaryProps) {
  const content = summaryContent(fields)
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} title={content.secondary}>
      <ListRowContent {...content} />
    </div>
  )
}

// A single row in a chat list: an avatar (with an optional status dot), a title
// and dimmed description, an optional unsent-draft pencil indicator and context
// reading at the end, an optional close button after them, and an optional
// actions menu (Rename / Stop process / Archive / Delete, plus any extra
// `actions`) built on the shadcn context-menu primitive.
//
// The row body itself is ListRow, the shared shell a group-chat row also draws.
// That means the geometry, the active and hover treatment, the keyboard
// activation and the touch handling are not this component's to state, so the
// two rows cannot drift apart on any of them.
//
// Touch gestures: the row carries NO grip -- one press serves scroll, drag and
// menu, and movement is what tells them apart. The surrounding `chat-list` runs
// the long-press pickup (a ~500ms still hold arms a drag; a move before that is
// a scroll; a still hold long enough hands the press to this row menu -- see
// below). The shell keeps `touch-action: pan-y` so vertical scroll works until
// the pickup commits, and suppresses the browser's native long-press text
// behaviour. Desktop is untouched: right-click opens the menu, native HTML5 DnD
// drags the whole row.
//
// The primitive anchors the menu to the point it captures while handling the
// `contextmenu` event, and its built-in touch long-press cannot be switched off
// separately from that. A host that wants the menu on a schedule of its own
// keeps the trigger's `touchstart` from reaching it and dispatches its own
// `contextmenu` when the menu is due. That is what `chat-list` does.
//
// Title/description truncate; long content never grows the row. Self-contained,
// works in any list.
//
// The close button is the row's sibling laid over the row's padded end, not a
// child: the row is itself a button, and a control inside it is one assistive
// technology may never announce. It is always drawn, so touch reaches it as a
// pointer does, and laid over the row it keeps the row's background under it.
export function ChatListItem({ id, title, breadcrumb, description, avatarUrl, avatarName, active = false, disabled = false, status, context, hasDraft = false, onSelect, onRename, onStopProcess, onClose, closeLabel = 'Close', onArchive, onUnarchive, onDelete, actions, onPointerDown }: ChatListItemProps) {
  const row = (
    <ListRow
      {...summaryContent({ title, breadcrumb, description, status, avatarUrl, avatarName })}
      active={active}
      disabled={disabled}
      onSelect={() => onSelect?.(id)}
      onPointerDown={onPointerDown}
      // Room for the close button laid over the row's end: its size plus its
      // inset, at each pointer's size.
      className={onClose ? 'pr-8 pointer-coarse:pr-10' : undefined}
      trailing={
        hasDraft || context ? (
          <span className='ml-auto inline-flex shrink-0 items-center gap-1'>
            {hasDraft ? (
              <span title='Unsent draft' className='inline-flex items-center text-muted-foreground'>
                <Pencil className='size-3.5' aria-hidden />
                <span className='sr-only'>Unsent draft</span>
              </span>
            ) : null}
            {context ? (
              <ContextReading usedTokens={context.usedTokens} contextLimit={context.contextLimit} asOf={context.asOf} />
            ) : null}
          </span>
        ) : null
      }
    />
  )

  // The menu itself is row-context-menu: the width, the click guard and what
  // Delete looks like are its business, not this row's. What stays here is the
  // order the entries appear in and the wording of the three this row owns.
  //
  // Delete goes through `onDelete` rather than as an entry, so it is the same
  // Delete every other list in the kit draws. With no handlers at all the menu
  // component returns the row untouched, so this row needs no check of its own.
  const entries: RowMenuEntry[] = []

  if (onRename) {
    entries.push({ label: 'Rename', icon: <Pencil className='size-3' />, onSelect: () => onRename(id) })
  }

  // Host actions keep their position between Rename and Stop process, and keep
  // taking the row id -- that is this row's public contract, not the menu's.
  for (const action of actions ?? []) {
    entries.push({
      label: action.label,
      icon: action.icon,
      destructive: action.destructive,
      onSelect: () => action.onSelect(id),
    })
  }

  if (onStopProcess) {
    entries.push({ label: 'Stop process', icon: <Square className='size-3' />, onSelect: () => onStopProcess(id) })
  }

  // Last, right next to Delete -- the same parity a row's other destructive or
  // reversible-lifecycle move gets.
  if (onArchive) {
    entries.push({ label: 'Archive', icon: <Archive className='size-3' />, onSelect: () => onArchive(id) })
  }

  if (onUnarchive) {
    entries.push({ label: 'Unarchive', icon: <ArchiveRestore className='size-3' />, onSelect: () => onUnarchive(id) })
  }

  const item = (
    <RowContextMenu
      entries={entries}
      onDelete={onDelete ? () => onDelete(id) : undefined}
    >
      {row}
    </RowContextMenu>
  )
  if (!onClose) {
    return item
  }
  return (
    <div className='relative'>
      {item}
      <Button
        variant='ghost'
        size='icon-xs'
        aria-label={closeLabel}
        title={closeLabel}
        className='absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground pointer-coarse:size-8'
        onClick={() => onClose(id)}
      >
        <X />
      </Button>
    </div>
  )
}
