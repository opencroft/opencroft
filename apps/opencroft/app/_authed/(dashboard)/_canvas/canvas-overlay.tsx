'use client'

import { useLocation } from '@tanstack/react-router'
import * as lucideIcons from 'lucide-react'
import { type LucideIcon, X } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/scroll-area'

import { useChatTabsMaybe } from '@/app/_authed/(agent)/_lib/chat-tabs-context'
import { AiPanel } from '@/app/_authed/(dashboard)/_canvas/ai-panel'
import type { CommandNodeEntry } from '@/app/_authed/(dashboard)/_canvas/canvas-command-bar'
import { CommandBar, CommandBarMenu } from '@/app/_authed/(dashboard)/_canvas/command-bar'
import { InspectorContext } from '@/app/_authed/(dashboard)/_canvas/inspector-context'
import {
  useOverlay,
  useOverlayBackIntercept,
  useOverlaySlotValues,
} from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { SearchFindBar } from '@/app/_authed/(dashboard)/_canvas/search-find-bar'
import {
  recordKeydown,
  recordOverlayContentSeen,
  recordOverlayRender,
} from '@/app/_authed/(extension-runtime)/_client/debug-probe'
import type { CommandModeDefinition, CommandModeShortcut } from '@/app/_authed/(extension-runtime)/_client/host'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { ChatArea, ChatBar, ChatContent, ChatHeader } from '@/components/experimental/chat'
import { cn } from '@/lib/utils'

interface CanvasOverlayProps {
  nodes: CommandNodeEntry[]
  spaceName: string
  spaceSlug: string
  selectedNodeId: string | null
  mcpRequestsActive: boolean
  onFocusNode: (nodeId: string) => void
  onActiveChange?: (active: boolean) => void
  // Bumped once extension loading settles (see flow-editor.tsx) — commandModes
  // below is a copy taken from the registry, which itself does not trigger a
  // re-render when an extension registers into it after this component's
  // first render, so its memo has to depend on something that does.
  extensionsVersion: number
}

/**
 * The `KeyboardEvent.code` a declared shortcut resolves to, or undefined if
 * it names nothing usable.
 *
 * A compiled extension bundle built before shortcuts moved to `code` (see
 * CommandModeShortcut's own doc comment) declares the old `{ key: 'g' }`
 * shape — a character, not a physical key. Installed bundles keep running
 * exactly as compiled and are not touched by an app deploy, so `sc.code` is
 * undefined for one of those until it is reinstalled from a source that
 * declares the new field (a separate migration, tracked apart from this).
 * Falling back to the legacy field here, converted to the code it always
 * meant, is what keeps that extension's shortcut alive in the meantime
 * instead of it going silently dead — exactly the failure this file exists
 * to fix.
 *
 * Read via an explicitly-typed legacy shape rather than widening
 * CommandModeShortcut itself, so every NEW declaration is still forced onto
 * the code-only contract. Letters only: the old field was never used for
 * anything else, so a legacy digit or punctuation shortcut (never actually
 * declared by anything) is left unresolved rather than guessed at.
 */
export function resolveShortcutCode(sc: CommandModeShortcut): string | undefined {
  if (sc.code) {
    return sc.code
  }
  const legacyKey = (sc as unknown as { key?: unknown }).key
  return typeof legacyKey === 'string' && /^[a-zA-Z]$/.test(legacyKey) ? `Key${legacyKey.toUpperCase()}` : undefined
}

export function CanvasOverlay({
  nodes,
  spaceName,
  spaceSlug,
  selectedNodeId,
  mcpRequestsActive,
  onFocusNode,
  onActiveChange,
  extensionsVersion,
}: CanvasOverlayProps) {
  const {
    mode,
    params: modeParams,
    focusTick,
    commandFocused,
    slots,
    activate: activateMode,
    dismiss: dismissOverlay,
    setMode,
    setCommandFocused,
  } = useOverlay()
  // This is the surface that paints the slots, so it is the one place that
  // subscribes to their values — see useOverlaySlotValues.
  const slotValues = useOverlaySlotValues()
  const searchParams = new URLSearchParams(useLocation({ select: (l) => l.searchStr }))
  const chatParam = searchParams.get('chat') ?? null
  const chatTabs = useChatTabsMaybe()

  const extensionModes = useMemo(() => {
    const modes = extensionRegistry.allCommandModes()
    recordOverlayRender(
      extensionsVersion,
      modes.map((m) => m.id),
    )
    return modes
  }, [extensionsVersion])

  useEffect(() => {
    if (!chatParam) {
      return
    }
    activateMode('ai')
  }, [chatParam, activateMode])

  // The sidebar's "Chats" entry bumps listRequest to open the session list here;
  // activating 'ai' surfaces it (docked in the inspector or as the focus overlay).
  const listRequest = chatTabs?.listRequest ?? 0
  useEffect(() => {
    if (!listRequest) {
      return
    }
    activateMode('ai')
  }, [listRequest, activateMode])

  // Matched on `event.code` (the physical key), not `event.key` (the
  // character it produces) — on a non-QWERTY layout the same physical F/P/I
  // keys sit in the same place but produce a different character, so a
  // `key`-based match silently never fires. `code` is layout-independent by
  // construction: `KeyF` is `KeyF` everywhere. Same reasoning for extension
  // shortcuts below — see CommandModeShortcut's `code` field.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }
      const code = event.code
      if (code === 'KeyF' || code === 'KeyP' || code === 'KeyI') {
        event.preventDefault()
        recordKeydown(
          code,
          extensionModes.map((m) => m.id),
          `builtin:${code}`,
        )
        activateMode(code === 'KeyF' ? 'search' : code === 'KeyP' ? 'find' : 'ai')
        return
      }
      for (const ext of extensionModes) {
        const sc = ext.shortcut
        if (!sc || resolveShortcutCode(sc) !== code) {
          continue
        }
        if (Boolean(sc.shift) !== event.shiftKey) {
          continue
        }
        if (Boolean(sc.alt) !== event.altKey) {
          continue
        }
        event.preventDefault()
        recordKeydown(
          code,
          extensionModes.map((m) => m.id),
          ext.id,
        )
        activateMode(ext.id)
        return
      }
      recordKeydown(
        code,
        extensionModes.map((m) => m.id),
        null,
      )
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [extensionModes, activateMode])

  const resetToAI = useCallback(() => {
    setMode('ai')
  }, [setMode])

  const { setNode: setInspectorNode } = useContext(InspectorContext)
  // Only AiPanel's chat is relocated to the inspector; every other overlay mode
  // (search, find, extension modes) keeps using the floating overlay. While the
  // MCP Requests tab is selected, the content slot belongs to request views
  // (e.g. diffs), so the chat must not claim it. In 'focused' chat mode the chat
  // is also kept out of the inspector and rendered as the floating overlay.
  const aiChatActive = chatTabs?.chatMode !== 'focused' && !mcpRequestsActive && mode === 'ai'

  useEffect(() => {
    recordOverlayContentSeen(mode, slotValues.content !== null, aiChatActive)
  }, [mode, slotValues.content, aiChatActive])

  // Notify parent when overlay content or header is active
  const prevActive = useRef(false)
  useEffect(() => {
    const active = !!(slotValues.content || slotValues.header)
    if (active !== prevActive.current) {
      prevActive.current = active
      onActiveChange?.(active)
    }
  }, [slotValues.content, slotValues.header, onActiveChange])

  const overlayActive = !!(slotValues.content || slotValues.header)

  const dismiss = useCallback(() => {
    dismissOverlay()
    // Closing the chat clears the active session; the provider then drops ?chat=.
    chatTabs?.setActiveKey(chatTabs.fallbackKey)
  }, [dismissOverlay, chatTabs])

  useOverlayBackIntercept(overlayActive, dismiss)

  // Dock the chat conversation (content + header) into the node inspector panel
  // instead of the floating overlay; the command bar input stays at the bottom.
  useEffect(() => {
    setInspectorNode(
      aiChatActive && slotValues.content ? (
        <InspectorChat header={slotValues.header} onClose={dismiss}>
          {slotValues.content}
        </InspectorChat>
      ) : null,
    )
  }, [aiChatActive, slotValues.content, slotValues.header, setInspectorNode, dismiss])
  useEffect(() => () => setInspectorNode(null), [setInspectorNode])

  const onOverlayMouseDown = useCallback(() => {
    dismiss()
  }, [dismiss])

  const onOverlayKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        dismiss()
      }
    },
    [dismiss],
  )

  const stopOverlayClose = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation()
  }, [])

  const activeExtMode = useMemo(() => extensionModes.find((m) => m.id === mode), [extensionModes, mode])

  const activeMode = (() => {
    if (mode === 'ai') {
      return (
        <AiPanel
          spaceName={spaceName}
          spaceSlug={spaceSlug}
          selectedNodeId={selectedNodeId}
          focused={commandFocused}
          onFocusChange={setCommandFocused}
        />
      )
    }
    if (mode === 'search' || mode === 'find') {
      return (
        <SearchFindBar
          mode={mode}
          nodes={nodes}
          focusTick={focusTick}
          onFocusNode={onFocusNode}
          onFocusChange={setCommandFocused}
          onReset={resetToAI}
        />
      )
    }
    if (activeExtMode) {
      const ModeComponent = activeExtMode.component
      return (
        <ModeComponent
          nodes={nodes}
          spaceName={spaceName}
          selectedNodeId={selectedNodeId}
          focusTick={focusTick}
          params={modeParams}
          onFocusNode={onFocusNode}
          onClose={resetToAI}
          onFocusChange={setCommandFocused}
        />
      )
    }
    return (
      <SearchFindBar
        mode='find'
        nodes={nodes}
        focusTick={focusTick}
        onFocusNode={onFocusNode}
        onFocusChange={setCommandFocused}
        onReset={resetToAI}
      />
    )
  })()

  return (
    <>
      {activeMode}
      <Flex
        row
        ref={slots.containerRef as React.RefObject<HTMLDivElement>}
        tabIndex={-1}
        onMouseDown={onOverlayMouseDown}
        onKeyDown={onOverlayKeyDown}
        className={cn(
          'absolute inset-0 z-10',
          (slotValues.content && !aiChatActive) || slotValues.menu ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={cn(
            'pointer-events-none absolute inset-0',
            'bg-background/80 transition-opacity duration-200',
            slotValues.content && !aiChatActive ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div className='absolute top-3 left-3 z-20'>
          <ExtensionModeLaunchers
            modes={extensionModes}
            activeId={mode}
            onActivate={activateMode}
            onDeactivate={dismiss}
          />
        </div>
        {slotValues.content && !aiChatActive && (
          <button
            type='button'
            title='Close overlay'
            aria-label='Close overlay'
            onMouseDown={(e) => e.stopPropagation()}
            onClick={dismiss}
            className='absolute top-3 right-3 z-20 pointer-events-auto size-7 inline-flex items-center justify-center rounded-md border bg-background/90 hover:bg-accent cursor-pointer'
          >
            <X className='size-4' />
          </button>
        )}
        <ChatArea>
          <ChatHeader fade={!!slotValues.content} onMouseDown={stopOverlayClose}>
            {aiChatActive ? null : slotValues.header}
          </ChatHeader>
          <ChatContent
            compact={!activeExtMode?.fullWidth}
            className={cn(
              'bg-background rounded-xl',
              'transition-opacity duration-200',
              slotValues.content && !aiChatActive ? 'opacity-100' : 'opacity-0',
            )}
            onMouseDown={stopOverlayClose}
          >
            {aiChatActive ? null : slotValues.content}
          </ChatContent>
          <ChatBar compact fade={!!slotValues.content} onMouseDown={stopOverlayClose}>
            {slotValues.menu && <CommandBarMenu>{slotValues.menu}</CommandBarMenu>}
            {slotValues.bar && <CommandBar>{slotValues.bar}</CommandBar>}
          </ChatBar>
        </ChatArea>
      </Flex>
    </>
  )
}

function modeIcon(name?: string): LucideIcon {
  const icons = lucideIcons as unknown as Record<string, LucideIcon>
  return (name && icons[name]) || lucideIcons.Puzzle
}

// Launcher buttons for extension command modes, pinned to the overlay's top-left corner.
// Clicking the active mode's button closes it again (toggle).
function ExtensionModeLaunchers({
  modes,
  activeId,
  onActivate,
  onDeactivate,
}: {
  modes: CommandModeDefinition[]
  activeId: string
  onActivate: (id: string) => void
  onDeactivate: () => void
}) {
  if (modes.length === 0) {
    return null
  }
  return (
    <div className='flex items-center gap-1 pointer-events-auto'>
      {modes.map((m) => {
        const Icon = modeIcon(m.icon)
        const active = activeId === m.id
        return (
          <button
            key={m.id}
            type='button'
            title={m.label}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => (active ? onDeactivate() : onActivate(m.id))}
            className={cn(
              'size-7 inline-flex items-center justify-center rounded-md border bg-background/90 hover:bg-accent cursor-pointer',
              active && 'bg-accent',
            )}
          >
            <Icon className='size-4' />
          </button>
        )
      })}
    </div>
  )
}

// The active chat conversation, docked inside the node inspector panel.
function InspectorChat({
  header,
  onClose,
  children,
}: {
  header: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <Flex expanded className='w-full h-full min-h-0 bg-card'>
      <Flex row align='center' className='gap-2 px-3 py-2 border-b shrink-0'>
        {/* `header` carries the back control on the conversation page (page 2); it
            is null on the list page (page 1), leaving just the title. */}
        {header}
        <span className='text-sm font-semibold flex-1 truncate'>Chat</span>
        <button
          type='button'
          onClick={onClose}
          className='size-6 inline-flex items-center justify-center rounded-md hover:bg-accent cursor-pointer'
          aria-label='Close chat'
        >
          <X className='size-3.5' />
        </button>
      </Flex>
      <ScrollArea
        className={cn(
          'flex-1 min-h-0',
          '[&_[data-radix-scroll-area-viewport]>div]:!flex',
          '[&_[data-radix-scroll-area-viewport]>div]:!flex-col',
          '[&_[data-radix-scroll-area-viewport]>div]:!min-h-full',
        )}
      >
        {children}
      </ScrollArea>
    </Flex>
  )
}
