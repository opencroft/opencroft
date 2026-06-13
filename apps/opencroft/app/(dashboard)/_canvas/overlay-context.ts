'use client'

import type * as React from 'react'
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type { CommandMode } from '@/app/(dashboard)/_canvas/canvas-command-bar'

type Slot = 'header' | 'content' | 'menu' | 'bar'

const BUILTIN_MODES: CommandMode[] = ['ai', 'search', 'find']

export interface OverlaySlots {
  header: ReactNode | null
  content: ReactNode | null
  menu: ReactNode | null
  bar: ReactNode | null
  setSlot: (slot: Slot, node: ReactNode | null) => void
  containerRef: React.RefObject<HTMLElement | null>
}

export interface OverlaySlotNodes {
  header?: ReactNode
  content?: ReactNode
  menu?: ReactNode
  bar?: ReactNode
}

export interface OverlayManager {
  mode: CommandMode
  focusTick: number
  commandFocused: boolean
  slots: OverlaySlots
  activate: (mode: CommandMode) => void
  dismiss: () => void
  setMode: (mode: CommandMode) => void
  setCommandFocused: (focused: boolean) => void
}

const OverlayManagerContext = createContext<OverlayManager | null>(null)

function useOverlayState(): OverlaySlots {
  const [header, setHeader] = useState<ReactNode | null>(null)
  const [content, setContent] = useState<ReactNode | null>(null)
  const [menu, setMenu] = useState<ReactNode | null>(null)
  const [bar, setBar] = useState<ReactNode | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)

  const setSlot = useCallback((slot: Slot, node: ReactNode | null) => {
    if (slot === 'header') {
      setHeader(node)
      return
    }
    if (slot === 'content') {
      setContent(node)
      return
    }
    if (slot === 'menu') {
      setMenu(node)
      return
    }
    setBar(node)
  }, [])

  return { header, content, menu, bar, setSlot, containerRef }
}

/** Owns the overlay's mode and slot state; useOverlay() works below this provider. */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const slots = useOverlayState()
  const [mode, setMode] = useState<CommandMode>('ai')
  const [focusTick, setFocusTick] = useState(0)
  const [commandFocused, setCommandFocused] = useState(false)

  const activate = useCallback((next: CommandMode) => {
    setMode(next)
    setCommandFocused(true)
    setFocusTick((t) => t + 1)
  }, [])

  const dismiss = useCallback(() => {
    setCommandFocused(false)
    slots.setSlot('content', null)
    slots.setSlot('menu', null)
    // Extension modes live entirely in the overlay — leaving one active after a
    // dismiss keeps its launcher highlighted and its component mounted with a
    // stale (cleared) content slot. Fall back to the default mode instead.
    setMode((prev) => (BUILTIN_MODES.includes(prev) ? prev : 'ai'))

    const focused = document.activeElement
    if (focused instanceof HTMLElement) {
      focused.blur()
    }
  }, [slots.setSlot])

  const manager: OverlayManager = {
    mode,
    focusTick,
    commandFocused,
    slots,
    activate,
    dismiss,
    setMode,
    setCommandFocused,
  }

  return createElement(OverlayManagerContext.Provider, { value: manager }, children)
}

function useManagedSlot(slot: Slot, nodes: OverlaySlotNodes | undefined, setSlot: OverlaySlots['setSlot']): void {
  const enabled = nodes !== undefined && slot in nodes
  const node = enabled ? (nodes[slot] ?? null) : null
  useLayoutEffect(() => {
    if (!enabled) {
      return
    }
    setSlot(slot, node)
  }, [enabled, slot, node, setSlot])
  useLayoutEffect(() => {
    if (!enabled) {
      return
    }
    return () => setSlot(slot, null)
  }, [enabled, slot, setSlot])
}

/**
 * Overlay control: read the active mode, activate or dismiss modes, and
 * publish overlay slots — `useOverlay({ content, bar })` keeps those slots in
 * sync while the calling component is mounted and clears them on unmount.
 */
export function useOverlay(nodes?: OverlaySlotNodes): OverlayManager {
  const manager = useContext(OverlayManagerContext)
  if (!manager) {
    throw new Error('useOverlay must be used within an <OverlayProvider>')
  }
  useManagedSlot('header', nodes, manager.slots.setSlot)
  useManagedSlot('content', nodes, manager.slots.setSlot)
  useManagedSlot('menu', nodes, manager.slots.setSlot)
  useManagedSlot('bar', nodes, manager.slots.setSlot)
  return manager
}

export function useBackIntercept(active: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const pushedRef = useRef(false)

  useEffect(() => {
    const nav = window.navigation
    if (!nav) {
      return
    }

    if (active && !pushedRef.current) {
      history.pushState(null, '')
      pushedRef.current = true
    }

    function onNavigate(e: NavigateEvent) {
      if (e.navigationType !== 'traverse') {
        return
      }
      if (!pushedRef.current) {
        return
      }
      e.intercept({
        handler() {
          pushedRef.current = false
          onCloseRef.current()
        },
      })
    }

    nav.addEventListener('navigate', onNavigate)
    return () => {
      nav.removeEventListener('navigate', onNavigate)
      if (pushedRef.current) {
        pushedRef.current = false
        history.back()
      }
    }
  }, [active])
}

export { useBackIntercept as useOverlayBackIntercept }
