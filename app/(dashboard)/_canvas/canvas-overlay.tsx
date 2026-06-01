'use client'

import { useLocation, useRouter } from '@tanstack/react-router'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ApprovalBar } from '@/app/(approvals)/_components/approval-bar'
import { AskUserBar } from '@/app/(approvals)/_components/ask-user-bar'
import { AiPanel } from '@/app/(dashboard)/_canvas/ai-panel'
import type { CommandMode, CommandNodeEntry } from '@/app/(dashboard)/_canvas/canvas-command-bar'
import { CommandBar, CommandBarMenu } from '@/app/(dashboard)/_canvas/command-bar'
import { OverlayContext, useOverlayBackIntercept, useOverlayState } from '@/app/(dashboard)/_canvas/overlay-context'
import { SearchFindBar } from '@/app/(dashboard)/_canvas/search-find-bar'
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry'
import { loadAiSettings } from '@/app/(settings)/_server/ai-actions'
import { useSSEEvents } from '@/app/(sse)/_lib/sse-events-store'
import { ChatArea, ChatBar, ChatContent, ChatHeader } from '@/components/experimental/chat'
import { Flex } from '@/components/ui/layout/flex'
import { cn } from '@/lib/utils'

interface CanvasOverlayProps {
  nodes: CommandNodeEntry[]
  spaceName: string
  spaceSlug: string
  selectedNodeId: string | null
  onFocusNode: (nodeId: string) => void
  onActiveChange?: (active: boolean) => void
}

export function CanvasOverlay({ nodes, spaceName, spaceSlug, selectedNodeId, onFocusNode, onActiveChange }: CanvasOverlayProps) {
  const [commandFocused, setCommandFocused] = useState(false)
  const [mode, setMode] = useState<CommandMode>('ai')
  const [agentId, setAgentId] = useState<string | null>(null)
  const [focusTick, setFocusTick] = useState(0)
  const initialized = useRef(false)
  const searchParams = new URLSearchParams(useLocation({ select: (l) => l.searchStr }))
  const router = useRouter()
  const pathname = useLocation({ select: (l) => l.pathname })
  const chatParam = searchParams.get('chat') ?? null

  const extensionModes = useMemo(() => extensionRegistry.allCommandModes(), [])

  useEffect(() => {
    loadAiSettings().then((s) => {
      setAgentId(s.defaultAgentId)
      if (!initialized.current) {
        initialized.current = true
        if (!s.defaultAgentId) {
          setMode('search')
        }
      }
    })
  }, [])

  const activateMode = useCallback((next: CommandMode) => {
    setMode(next)
    setCommandFocused(true)
    setFocusTick((t) => t + 1)
  }, [])

  useEffect(() => {
    if (!chatParam) {
      return
    }
    activateMode('ai')
  }, [chatParam, activateMode])

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
  }, [])

  const { pendingApprovals, selectedApprovalId, pendingAskUsers, selectedAskUserId } = useSSEEvents()
  const selectedApproval = selectedApprovalId ? pendingApprovals.get(selectedApprovalId) : null
  const selectedAskUser = selectedAskUserId ? pendingAskUsers.get(selectedAskUserId) : null

  const slots = useOverlayState()

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
    setCommandFocused(false)
    slots.setSlot('content', null)
    slots.setSlot('menu', null)

    const active = document.activeElement
    if (active instanceof HTMLElement) {
      active.blur()
    }

    if (chatParam && pathname) {
      router.navigate({ to: pathname, replace: true })
    }
  }, [chatParam, pathname, router])

  useOverlayBackIntercept(overlayActive, dismiss)

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

  const activeMode = (() => {
    if (selectedApproval) {
      return <ApprovalBar request={selectedApproval} />
    }
    if (selectedAskUser) {
      return <AskUserBar request={selectedAskUser} />
    }
    if (mode === 'ai' && agentId) {
      return <AiPanel agentId={agentId} spaceName={spaceName} spaceSlug={spaceSlug} selectedNodeId={selectedNodeId} focused={commandFocused} onFocusChange={setCommandFocused} />
    }
    if (mode === 'search' || mode === 'find') {
      return <SearchFindBar mode={mode} nodes={nodes} focusTick={focusTick} onFocusNode={onFocusNode} onFocusChange={setCommandFocused} onReset={resetToAI} />
    }
    const extMode = extensionModes.find((m) => m.id === mode)
    if (extMode) {
      const ModeComponent = extMode.component
      return <ModeComponent nodes={nodes} spaceName={spaceName} selectedNodeId={selectedNodeId} focusTick={focusTick} onFocusNode={onFocusNode} onClose={resetToAI} onFocusChange={setCommandFocused} />
    }
    return <SearchFindBar mode='find' nodes={nodes} focusTick={focusTick} onFocusNode={onFocusNode} onFocusChange={setCommandFocused} onReset={resetToAI} />
  })()

  return (
    <OverlayContext.Provider value={{ setSlot: slots.setSlot, containerRef: slots.containerRef }}>
      {activeMode}
      <Flex
        row
        ref={slots.containerRef as React.RefObject<HTMLDivElement>}
        tabIndex={-1}
        onMouseDown={onOverlayMouseDown}
        onKeyDown={onOverlayKeyDown}
        className={cn('absolute inset-0 z-10', slots.content || slots.menu ? 'pointer-events-auto' : 'pointer-events-none')}
      >
        <div className={cn('pointer-events-none absolute inset-0', 'bg-background/80 transition-opacity duration-200', slots.content ? 'opacity-100' : 'opacity-0')} />
        <ChatArea>
          <ChatHeader fade={!!slots.content} onMouseDown={stopOverlayClose}>
            {slots.header}
          </ChatHeader>
          <ChatContent compact className={cn('bg-background rounded-xl', 'transition-opacity duration-200', slots.content ? 'opacity-100' : 'opacity-0')} onMouseDown={stopOverlayClose}>
            {slots.content}
          </ChatContent>
          <ChatBar compact fade={!!slots.content} onMouseDown={stopOverlayClose}>
            {slots.menu && <CommandBarMenu>{slots.menu}</CommandBarMenu>}
            {slots.bar && <CommandBar>{slots.bar}</CommandBar>}
          </ChatBar>
        </ChatArea>
      </Flex>
    </OverlayContext.Provider>
  )
}
