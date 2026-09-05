'use client'

import { MessagesSquare, PanelBottom, PanelLeft, PanelRight, PictureInPicture2, X } from 'lucide-react'
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
import { useIsMobile } from 'ui/hooks/use-mobile'
import { DockPanel, type DockSide } from 'ui/layouts/dock-panel'

import { ChatSelector } from '@/app/_authed/(extension-runtime)/_client/chat-selector'
import type { EmbeddedChatSelection } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import { EmbeddedAgentChat } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
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
  // deliberately not persisted: a fresh page starts on the default.
  const [chatSelection, setChatSelection] = useState<EmbeddedChatSelection>()

  // The window's arrangement DURING a drag, so the store is written once per
  // gesture rather than per pointer move -- the same contract the docked
  // panel's onSizeChange keeps.
  const [liveFloat, setLiveFloat] = useState<FloatRect | null>(null)
  const floatRect = liveFloat ?? float

  useHistoryBackClose(isMobile && open, () => setOpen(false))

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
    <EmbeddedAgentChat space={space} id={id} thread={chatSelection} title={chatName} className='min-h-0 flex-1' />
  )

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
        title={title}
        actions={
          <>
            <ChatSelector space={space} selection={chatSelection} onChange={setChatSelection} size='icon' />
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
    <Button
      size='icon'
      aria-label='Open chat'
      title='Open chat'
      className='fixed right-4 bottom-4 z-40 size-14 rounded-full shadow-lg'
      onClick={() => setOpen(true)}
    >
      <MessagesSquare className='size-6' />
    </Button>
  ) : isMobile ? (
    <div className='fixed inset-0 z-50 flex min-h-0 flex-col bg-background'>
      {/* Touch targets, not pointer targets, on the full-screen cover. */}
      <div className='flex items-center justify-between gap-2 border-b px-3 py-2'>
        <span className='truncate text-sm font-medium text-foreground'>{title}</span>
        <div className='flex items-center gap-1'>
          <ChatSelector space={space} selection={chatSelection} onChange={setChatSelection} size='icon-sm' />
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
        <span className='truncate text-xs text-muted-foreground'>{title}</span>
        <div onPointerDown={(e) => e.stopPropagation()} className='flex shrink-0 items-center gap-0.5'>
          <ChatSelector space={space} selection={chatSelection} onChange={setChatSelection} size='icon' />
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
