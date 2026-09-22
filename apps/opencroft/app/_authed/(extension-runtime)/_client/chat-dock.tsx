'use client'

import { useSession } from '@opencroft/auth/client'
import { PanelBottom, PanelLeft, PanelRight, PictureInPicture2, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { Button } from 'ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from 'ui/dropdown-menu'
import { ChatLauncher } from 'ui/group-chat/chat-launcher'
import { ThreadAgentCluster } from 'ui/group-chat/thread-agent-cluster'
import { ThreadWorkControl } from 'ui/group-chat/thread-work-control'
import { useIsMobile } from 'ui/hooks/use-mobile'
import { DockPanel, type DockSide } from 'ui/layouts/dock-panel'
import { BackButton } from 'ui/utils/back-button'

import { useSessionActivityKeys } from '@/app/_authed/(agent)/_lib/use-session-activity'
import type {
  EmbeddedChatSelection,
  EmbeddedThreadContext,
} from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import { EmbeddedAgentChat } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import type { GroupChatDetailHeader } from '@/app/_authed/(group-chats)/_components/group-chat-detail-screen'
import { countChatThreadKeys } from '@/app/_authed/(group-chats)/_shared/session-key'
import { useHistoryBackClose } from '@/hooks/utils/use-history-back-close'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'

/** Where the chat panel sits when it is open: docked to an edge, or floating. */
export type ChatDockMode = DockSide | 'float'

// ONE ARRANGEMENT FOR THE PERSON, NOT ONE PER SURFACE. Where the chat sits,
// its size and whether it is open follow the reader across every surface that
// mounts this component -- spaces and extension views alike -- so opening a
// different one shows the chat where this browser left it.
//
// The retired per-surface entries (`opencroft.spaceChat.*` and the
// `opencroft.<extension>.chatDock` family) are left exactly where they lie,
// never read, deliberately: no fallback, no migration, no cleanup pass --
// code written to service a legacy shape is the legacy being dropped.
//
// Per browser rather than per account, because this is local storage -- the
// arrangement does not follow the reader to another machine. That is inherent
// to where it is stored, not a decision taken here.
const OPEN_KEY = 'opencroft.chatDock.open'
const MODE_KEY = 'opencroft.chatDock.mode'
const SIZE_KEY = 'opencroft.chatDock.size'
const FLOAT_KEY = 'opencroft.chatDock.float'

// WHICH CONVERSATION, unlike the four keys above, is scoped twice over.
//
// By SPACE, because the chats are per space: one key for all of them would
// restore the previous space's thread on arriving at the next one, and a thread
// belonging to a chat this surface does not address resolves to "This thread is
// not available" -- a refusal that reads as a defect rather than as a browser
// remembering the wrong thing.
//
// By ACCOUNT, which the four above deliberately are not, and the difference is
// what the value IS. A dock side or a window size is a layout preference, and
// two accounts sharing one browser sharing it costs nothing. This is a pointer
// into conversation data, and the second account is refused by the same panel
// for the same reason -- so the sharing that is harmless for an arrangement is
// not harmless for this.
function lastChatKey(accountId: string, space: string): string {
  return `opencroft.chatDock.lastChat.${accountId}.${space}`
}

const MODE_DEFAULT: ChatDockMode = 'right'

// The floating window first: it is the arrangement this menu's own launcher
// suggests, and the three docks read as one family below it.
const MODES: ChatDockMode[] = ['float', 'left', 'right', 'bottom']

const MODE_ICONS = { left: PanelLeft, right: PanelRight, bottom: PanelBottom, float: PictureInPicture2 }

const MODE_LABELS: Record<ChatDockMode, string> = {
  left: 'Dock to the left',
  right: 'Dock to the right',
  bottom: 'Dock to the bottom',
  float: 'Floating window',
}

/**
 * The floating window's arrangement. Anchored to the bottom edge by decision
 * -- the reader slides it along that edge and stretches it upward and
 * sideways, so the bottom margin is a constant and only these three vary.
 */
interface FloatRect {
  /** Distance from the viewport's right edge, px. */
  right: number
  width: number
  height: number
}

const FLOAT_DEFAULT: FloatRect = { right: 16, width: 400, height: 520 }
/** The gap the window keeps from the viewport's edges, px. */
const FLOAT_MARGIN = 16
const FLOAT_MIN_WIDTH = 320
const FLOAT_MIN_HEIGHT = 280

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/**
 * The four positions in ONE control rather than a row of toggles: three docks
 * plus the floating window would be four buttons wide, and the header they sit
 * in also holds the conversation switch and the close button.
 */
function ModeMenu({ mode, onModeChange }: { mode: ChatDockMode; onModeChange: (mode: ChatDockMode) => void }) {
  const Icon = MODE_ICONS[mode]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' aria-label='Panel position' title='Panel position'>
          <Icon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuRadioGroup value={mode} onValueChange={(value) => onModeChange(value as ChatDockMode)}>
          {MODES.map((option) => {
            const OptionIcon = MODE_ICONS[option]
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <OptionIcon className='size-4 text-muted-foreground' />
                {MODE_LABELS[option]}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface Props {
  /** The group chat's address: the space's slug. */
  space: string
  /** The thread slug this surface addresses by default. */
  id: string
  /** What the panel's header calls the conversation. */
  title: string
  /** The chat's display name, used only if it has to be created. */
  chatName?: string
  /** The surface the chat sits beside, floats over, or covers. */
  children: ReactNode
}

/**
 * A surface's agent chat: closed, it is a floating launcher in the bottom
 * right corner; open, it docks to an edge of the surface, floats above it in
 * a window the reader drags along the bottom edge and stretches, or -- below
 * the kit's mobile breakpoint -- covers the surface outright, because a side
 * panel there is a fight for width neither side can win.
 *
 * ONE component for every surface that embeds a chat, mounted by the space
 * canvas and handed to extensions through the host API -- so the launcher,
 * the arrangement switch, the conversation switch and the Back behaviour are
 * one implementation, and a fix to any of them reaches every surface at once.
 *
 * It does NOT provide the selection scope: which elements feed the composer
 * is the surface's own affair, so callers mount their SelectionProvider
 * around this component and their selection bridges inside it.
 *
 * The covering container is a plain positioned element rather than the kit's
 * Sheet, deliberately: it is not a modal at all. No overlay, no focus trap,
 * no portal, no dismissal semantics -- a Sheet would be four things
 * configured away to arrive back at a div. What it costs is stated where it
 * is chosen: the surface stays in the tab order behind the cover, and Escape
 * does not close it. What the cover DOES honour is the Back action, because
 * on a phone that is the reflex for "leave what is covering the screen".
 */
export function ChatDock({ space, id, title, chatName, children }: Props) {
  const [open, setOpen] = useLocalStorage<boolean>(OPEN_KEY, false)
  const [mode, setMode] = useLocalStorage<ChatDockMode>(MODE_KEY, MODE_DEFAULT)
  // Undefined until one has been set, which is what tells the docked panel to
  // keep its own default rather than being resized to a remembered nothing.
  const [size, setSize] = useLocalStorage<number | undefined>(SIZE_KEY, undefined)
  const [float, setFloat] = useLocalStorage<FloatRect>(FLOAT_KEY, FLOAT_DEFAULT)
  const isMobile = useIsMobile()

  // Which conversation the panel shows; unset = the surface's default thread.
  // Held here (not deeper) so it survives closing and reopening the chat, and
  // persisted so it also survives leaving the surface -- reopening one lands
  // back in the conversation rather than on the default thread.
  //
  // A "new chat" that was never sent is remembered like any other, because at
  // this level the two are the same value and telling them apart would mean
  // asking the server whether the thread exists yet. What that costs is a
  // start composer restored under the timestamp it was first offered under;
  // what the alternative would cost is the common case, since a new chat that
  // HAS been sent is still a `newId` and dropping those would forget every
  // conversation started from this menu.
  //
  // The account is unresolved for the first render or two while the shared
  // session atom answers (the sidebar's own sign-out item has it in flight
  // already). The key changing is what makes the hook re-read, so the cost is
  // a pick made inside that window being written under a key nothing reads
  // again -- not a restore of the wrong account's chat.
  const { data: session } = useSession()
  const [chatSelection, setChatSelection] = useLocalStorage<EmbeddedChatSelection | undefined>(
    lastChatKey(session?.user.id ?? 'unresolved', space),
    undefined,
  )

  // What the open thread's header says -- who it is with, where it is, what
  // it has delegated -- as the surface reports it; null while no thread is
  // open. Held HERE because the header is this component's: the surface has
  // no header of its own inside the window, so it hands the facts up.
  const [threadContext, setThreadContext] = useState<EmbeddedThreadContext | null>(null)
  // The chat's home screen's header -- its name or search field, and its
  // controls -- as the surface reports it while the home screen is open; null
  // otherwise. Held here for the same reason as the thread context: the
  // window has one header, and both screens put their parts in it.
  const [homeHeader, setHomeHeader] = useState<GroupChatDetailHeader | null>(null)

  // The window's arrangement DURING a drag, so the store is written once per
  // gesture rather than per pointer move -- the same contract the docked
  // panel's onSizeChange keeps.
  const [liveFloat, setLiveFloat] = useState<FloatRect | null>(null)
  const floatRect = liveFloat ?? float

  useHistoryBackClose(isMobile && open, () => setOpen(false))

  // The chat's threads waiting on someone -- a permission to grant or a
  // question to answer -- for the launcher's badge, off the same shared poll
  // every chat list reads. Polled only while the launcher is what shows: an
  // open panel carries each thread's own status.
  const { pendingKeys } = useSessionActivityKeys(!open)
  const waitingCount = countChatThreadKeys(pendingKeys, space)

  const beginFloatGesture = (
    event: React.PointerEvent,
    move: (dx: number, dy: number, start: FloatRect) => FloatRect,
  ) => {
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    const start = floatRect
    const from = { x: event.clientX, y: event.clientY }
    let last = start
    const onMove = (ev: PointerEvent) => {
      last = move(ev.clientX - from.x, ev.clientY - from.y, start)
      setLiveFloat(last)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setFloat(last)
      setLiveFloat(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const dragFloat = (event: React.PointerEvent) =>
    beginFloatGesture(event, (dx, _dy, start) => ({
      ...start,
      right: clamp(
        start.right - dx,
        FLOAT_MARGIN,
        Math.max(FLOAT_MARGIN, window.innerWidth - start.width - FLOAT_MARGIN),
      ),
    }))

  const resizeFloat = (event: React.PointerEvent, edge: { top?: boolean; left?: boolean; right?: boolean }) =>
    beginFloatGesture(event, (dx, dy, start) => {
      let { right, width, height } = start
      if (edge.left) {
        width = clamp(
          start.width - dx,
          FLOAT_MIN_WIDTH,
          Math.max(FLOAT_MIN_WIDTH, window.innerWidth - start.right - FLOAT_MARGIN),
        )
      }
      if (edge.right) {
        // The right edge follows the pointer while the LEFT edge stays put:
        // the window is positioned off the right, so the width and the offset
        // trade the same pixels.
        const traded = clamp(dx, FLOAT_MIN_WIDTH - start.width, start.right - FLOAT_MARGIN)
        width = start.width + traded
        right = start.right - traded
      }
      if (edge.top) {
        height = clamp(
          start.height - dy,
          FLOAT_MIN_HEIGHT,
          Math.max(FLOAT_MIN_HEIGHT, window.innerHeight - 2 * FLOAT_MARGIN),
        )
      }
      return { right, width, height }
    })

  // `min-h-0` here and on every column above it: without it the chat's own
  // scroller resolves its height against its content rather than the column,
  // and the composer rides up under the last message instead of staying at
  // the bottom -- the same trap the group-chat screen hit.
  const chat = (
    <EmbeddedAgentChat
      space={space}
      id={id}
      thread={chatSelection}
      onSelectionChange={setChatSelection}
      title={chatName}
      onThreadContext={setThreadContext}
      onHomeHeader={setHomeHeader}
      className='min-h-0 flex-1'
    />
  )

  // The home screen's header parts, placed in the window's header exactly as
  // an open thread's cluster and work button are: its title area (the chat's
  // name, or the search field while a search is open) where the cluster
  // goes, its controls ahead of the window's own. The title area stops the
  // pointer too -- in the floating window the header is the drag handle, and
  // typing into a search field must not slide the window.
  const stopPointer = (e: React.PointerEvent) => e.stopPropagation()
  const homeTitle = homeHeader?.title ? (
    <div onPointerDown={stopPointer} className='min-w-0 flex-1'>
      {homeHeader.title}
    </div>
  ) : null
  const homeActions = homeHeader?.actions ?? null

  // The header names the open conversation the way a chat list row does --
  // the agent's avatar with the status dot, `{space} / {thread}` over
  // `{agent} · {status}` -- once the surface has reported one, and falls back
  // to the surface's title until then. ONE node for all three arrangements,
  // so the docked panel, the phone cover and the floating window cannot say
  // different things about one thread.
  //
  // Back leads it: an open thread is the second of the panel's two windows,
  // and the arrow returns to the first -- the chat's home, where the threads
  // are listed, searched and started. That home is what replaced the "Choose
  // a chat" menu this header used to carry. The buttons stop the pointer so
  // the floating window's drag handle does not read a press as a slide.
  const cluster = threadContext ? (
    <div className='flex min-w-0 flex-1 items-center gap-1'>
      <BackButton
        label='Back to the chat'
        onClick={() => setChatSelection({ home: true })}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <ThreadAgentCluster
        agent={threadContext.agent}
        status={threadContext.status}
        groupChatName={threadContext.groupChatName}
        threadTitle={threadContext.threadTitle}
        className='min-w-0 flex-1'
      />
    </div>
  ) : null
  // The delegated-work control sits with the conversation controls, the same
  // size and shape as the chat switch beside it. It draws nothing until the
  // thread has delegated something to list.
  const workButton = (buttonSize: 'icon' | 'icon-sm') =>
    threadContext ? <ThreadWorkControl work={threadContext.work} size={buttonSize} /> : null

  const surface = <div className='flex min-h-0 min-w-0 flex-1'>{children}</div>

  const closeButton = (buttonSize: 'icon' | 'icon-sm') => (
    <Button variant='ghost' size={buttonSize} aria-label='Close chat' title='Close chat' onClick={() => setOpen(false)}>
      <X />
    </Button>
  )

  if (open && !isMobile && mode !== 'float') {
    return (
      <DockPanel
        dock={mode}
        size={size}
        onSizeChange={setSize}
        title={cluster ?? homeTitle ?? title}
        actions={
          <>
            {homeActions}
            {workButton('icon')}
            <ModeMenu mode={mode} onModeChange={setMode} />
            {closeButton('icon')}
          </>
        }
        panel={chat}
        className='h-full w-full'
      >
        {surface}
      </DockPanel>
    )
  }

  // The launcher, the cover and the window are all FIXED, not absolute: the
  // page around an extension's surface can scroll, and a corner anchored to a
  // container rides away with it -- these belong to the viewport.
  const overlay = !open ? (
    <ChatLauncher waitingCount={waitingCount} className='fixed right-4 bottom-4 z-40' onClick={() => setOpen(true)} />
  ) : isMobile ? (
    <div className='fixed inset-0 z-50 flex min-h-0 flex-col bg-background'>
      {/* Touch targets, not pointer targets, on the full-screen cover. */}
      <div className='flex items-center justify-between gap-2 border-b px-3 py-2'>
        {cluster ?? homeTitle ?? <span className='truncate text-sm font-medium text-foreground'>{title}</span>}
        <div className='flex shrink-0 items-center gap-1'>
          {homeActions}
          {workButton('icon-sm')}
          {closeButton('icon-sm')}
        </div>
      </div>
      {chat}
    </div>
  ) : (
    <div
      className='fixed z-40 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl'
      style={{
        right: floatRect.right,
        bottom: FLOAT_MARGIN,
        width: floatRect.width,
        height: floatRect.height,
        maxWidth: `calc(100vw - ${2 * FLOAT_MARGIN}px)`,
        maxHeight: `calc(100vh - ${2 * FLOAT_MARGIN}px)`,
      }}
    >
      {/* The header is the drag handle; its buttons stop the pointer so a
          click on them is a click, not the start of a slide. */}
      <div
        onPointerDown={dragFloat}
        className='flex shrink-0 cursor-grab touch-none select-none items-center justify-between gap-2 border-b border-border px-2 py-1'
      >
        {cluster ?? homeTitle ?? <span className='truncate text-xs text-muted-foreground'>{title}</span>}
        <div onPointerDown={stopPointer} className='flex shrink-0 items-center gap-0.5'>
          {homeActions}
          {workButton('icon')}
          <ModeMenu mode={mode} onModeChange={setMode} />
          {closeButton('icon')}
        </div>
      </div>
      {chat}
      {/* Grow-from handles on the top and both sides -- the bottom is the
          anchor. Sizing the left edge moves that edge; sizing the right one
          keeps the left edge put and slides the window's offset instead. */}
      <div
        aria-hidden
        onPointerDown={(e) => resizeFloat(e, { top: true })}
        className='absolute inset-x-5 top-0 h-2 cursor-ns-resize touch-none'
      />
      <div
        aria-hidden
        onPointerDown={(e) => resizeFloat(e, { left: true })}
        className='absolute inset-y-5 left-0 w-2 cursor-ew-resize touch-none'
      />
      <div
        aria-hidden
        onPointerDown={(e) => resizeFloat(e, { right: true })}
        className='absolute inset-y-5 right-0 w-2 cursor-ew-resize touch-none'
      />
      <div
        aria-hidden
        onPointerDown={(e) => resizeFloat(e, { top: true, left: true })}
        className='absolute top-0 left-0 size-5 cursor-nwse-resize touch-none'
      />
      <div
        aria-hidden
        onPointerDown={(e) => resizeFloat(e, { top: true, right: true })}
        className='absolute top-0 right-0 size-5 cursor-nesw-resize touch-none'
      />
    </div>
  )

  return (
    <div className='flex h-full min-h-0 w-full'>
      {surface}
      {overlay}
    </div>
  )
}
