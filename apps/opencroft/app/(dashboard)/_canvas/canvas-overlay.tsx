'use client'

import { useLocation } from '@tanstack/react-router'
import * as lucideIcons from 'lucide-react'
import { type LucideIcon, X } from 'lucide-react'
import type * as React from 'react'
import { useCallback, useContext, useEffect, useMemo, useRef } from 'react'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/scroll-area'

import { useChatTabsMaybe } from '@/app/(agent)/_lib/chat-tabs-context'
import { AiPanel } from '@/app/(dashboard)/_canvas/ai-panel'
import type { CommandNodeEntry } from '@/app/(dashboard)/_canvas/canvas-command-bar'
import { CommandBar, CommandBarMenu } from '@/app/(dashboard)/_canvas/command-bar'
import { InspectorContext } from '@/app/(dashboard)/_canvas/inspector-context'
import { useOverlay, useOverlayBackIntercept } from '@/app/(dashboard)/_canvas/overlay-context'
import { SearchFindBar } from '@/app/(dashboard)/_canvas/search-find-bar'
import type { CommandModeDefinition } from '@/app/(extension-runtime)/_client/host'
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry'
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
}

export function CanvasOverlay({
  nodes,
  spaceName,
  spaceSlug,
  selectedNodeId,
  mcpRequestsActive,
  onFocusNode,
  onActiveChange,
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
  const searchParams = new URLSearchParams(useLocation({ select: (l) => l.searchStr }))
  const chatParam = searchParams.get('chat') ?? null
  const chatTabs = useChatTabsMaybe()

  const extensionModes = useMemo(() => extensionRegistry.allCommandModes(), [])

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

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }
      const key = event.key.toLowerCase()
      if (key === 'f' || key === 'p' || key === 'i') {
        event.preventDefault()
        activateMode(key === 'f' ? 'search' : key === 'p' ? 'find' : 'ai')
        return
      }
      for (const ext of extensionModes) {
        const sc = ext.shortcut
        if (!sc || sc.key.toLowerCase() !== key) {
          continue
        }
        if (Boolean(sc.shift) !== event.shiftKey) {
          continue
        }
        if (Boolean(sc.alt) !== event.altKey) {
          continue
        }
        event.preventDefault()
        activateMode(ext.id)
        return
      }
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

  // Notify parent when overlay content or header is active
  const prevActive = useRef(false)
  useEffect(() => {
    const active = !!(slots.content || slots.header)
    if (active !== prevActive.current) {
      prevActive.current = active
      onActiveChange?.(active)
    }
  }, [slots.content, slots.header, onActiveChange])

  const overlayActive = !!(slots.content || slots.header)

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
      aiChatActive && slots.content ? (
        <InspectorChat header={slots.header} onClose={dismiss}>
          {slots.content}
        </InspectorChat>
      ) : null,
    )
  }, [aiChatActive, slots.content, slots.header, setInspectorNode, dismiss])
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
          (slots.content && !aiChatActive) || slots.menu ? 'pointer-events-auto' : 'pointer-events-none',
        )}
      >
        <div
          className={cn(
            'pointer-events-none absolute inset-0',
            'bg-background/80 transition-opacity duration-200',
            slots.content && !aiChatActive ? 'opacity-100' : 'opacity-0',
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
        {slots.content && !aiChatActive && (
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
          <ChatHeader fade={!!slots.content} onMouseDown={stopOverlayClose}>
            {aiChatActive ? null : slots.header}
          </ChatHeader>
          <ChatContent
            compact={!activeExtMode?.fullWidth}
            className={cn(
              'bg-background rounded-xl',
              'transition-opacity duration-200',
              slots.content && !aiChatActive ? 'opacity-100' : 'opacity-0',
            )}
            onMouseDown={stopOverlayClose}
          >
            {aiChatActive ? null : slots.content}
          </ChatContent>
          <ChatBar compact fade={!!slots.content} onMouseDown={stopOverlayClose}>
            {slots.menu && <CommandBarMenu>{slots.menu}</CommandBarMenu>}
            {slots.bar && <CommandBar>{slots.bar}</CommandBar>}
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
