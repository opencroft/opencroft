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
  useMemo,
  useRef,
  useState,
} from 'react'

import { type CommandMode, NO_COMMAND_MODE } from '@/app/_authed/(dashboard)/_canvas/canvas-command-bar'
import { recordManagerCall } from '@/app/_authed/(dashboard)/_canvas/ctrlg-debug'

type Slot = 'header' | 'content' | 'menu' | 'bar'

const BUILTIN_MODES: CommandMode[] = [NO_COMMAND_MODE, 'search', 'find']

/** How a slot is written, and where the overlay paints. Stable for the life of the provider. */
export interface OverlaySlotControls {
  setSlot: (slot: Slot, node: ReactNode | null) => void
  containerRef: React.RefObject<HTMLElement | null>
}

/** What has been published into each slot. */
export interface OverlaySlotValues {
  header: ReactNode | null
  content: ReactNode | null
  menu: ReactNode | null
  bar: ReactNode | null
}

export interface OverlaySlotNodes {
  header?: ReactNode
  content?: ReactNode
  menu?: ReactNode
  bar?: ReactNode
}

export interface OverlayManager {
  mode: CommandMode
  /** Params passed to the active mode's component (set by activate). */
  params: unknown
  focusTick: number
  commandFocused: boolean
  slots: OverlaySlotControls
  activate: (mode: CommandMode, params?: unknown) => void
  dismiss: () => void
  setMode: (mode: CommandMode) => void
  setCommandFocused: (focused: boolean) => void
}

// Two contexts, deliberately, and the split is the whole point of this module.
//
// The manager is the control surface — mode, focus, and the setter. The slot
// VALUES live apart from it, because a component that writes a slot must not
// subscribe to what it wrote.
//
// It used to. The manager was rebuilt on every provider render, so writing a
// slot produced a new context value, which re-rendered every holder of the
// manager INCLUDING the publisher that had just written. That publisher built a
// fresh node, published again, and the app died with "Maximum update depth
// exceeded". A slot node that was not reference-stable therefore did not cost a
// render, it hung the app — so every publisher had to hand-maintain reference
// stability forever, with a crash as the penalty for missing once.
//
// With the values kept out of the manager, a write cannot re-render a writer.
// Stability is an optimisation again: worth doing, not load-bearing.
const OverlayManagerContext = createContext<OverlayManager | null>(null)
const OverlaySlotValuesContext = createContext<OverlaySlotValues>({
  header: null,
  content: null,
  menu: null,
  bar: null,
})

function useOverlayState(): { controls: OverlaySlotControls; values: OverlaySlotValues } {
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

  const controls = useMemo(() => ({ setSlot, containerRef }), [setSlot])
  const values = useMemo(() => ({ header, content, menu, bar }), [header, content, menu, bar])
  return { controls, values }
}

/** Owns the overlay's mode and slot state; useOverlay() works below this provider. */
export function OverlayProvider({ children }: { children: ReactNode }) {
  const { controls: slots, values } = useOverlayState()
  const [mode, setModeState] = useState<CommandMode>(NO_COMMAND_MODE)
  const [params, setParams] = useState<unknown>(null)
  const [focusTick, setFocusTick] = useState(0)
  const [commandFocused, setCommandFocused] = useState(false)

  // TEMPORARY: every mode transition funnels through this one
  // wrapped setter, regardless of caller (activate, dismiss, or a bare
  // setMode from a consumer resetting to rest) -- so an unexplained transition
  // shows up in the log even from a caller nobody suspected yet.
  const setMode = useCallback((next: CommandMode | ((prev: CommandMode) => CommandMode)) => {
    setModeState((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: CommandMode) => CommandMode)(prev) : next
      recordManagerCall(prev, resolved)
      return resolved
    })
  }, [])

  const activate = useCallback(
    (next: CommandMode, nextParams?: unknown) => {
      setMode(next)
      setParams(nextParams ?? null)
      setCommandFocused(true)
      setFocusTick((t) => t + 1)
    },
    [setMode],
  )

  const dismiss = useCallback(() => {
    setCommandFocused(false)
    slots.setSlot('content', null)
    slots.setSlot('menu', null)
    // Extension modes live entirely in the overlay — leaving one active after a
    // dismiss keeps its launcher highlighted and its component mounted with a
    // stale (cleared) content slot. Fall back to the resting mode instead.
    setMode((prev) => (BUILTIN_MODES.includes(prev) ? prev : NO_COMMAND_MODE))

    const focused = document.activeElement
    if (focused instanceof HTMLElement) {
      focused.blur()
    }
  }, [slots.setSlot, setMode])

  // Memoised WITHOUT the slot values: publishing changes `values`, leaves this
  // identity alone, and so leaves every publisher un-rendered.
  const manager: OverlayManager = useMemo(
    () => ({ mode, params, focusTick, commandFocused, slots, activate, dismiss, setMode, setCommandFocused }),
    [mode, params, focusTick, commandFocused, slots, activate, dismiss, setMode],
  )

  return createElement(
    OverlayManagerContext.Provider,
    { value: manager },
    createElement(OverlaySlotValuesContext.Provider, { value: values }, children),
  )
}

function useManagedSlot(
  slot: Slot,
  nodes: OverlaySlotNodes | undefined,
  setSlot: OverlaySlotControls['setSlot'],
): void {
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
  const manager = useOptionalOverlay(nodes)
  if (!manager) {
    throw new Error('useOverlay must be used within an <OverlayProvider>')
  }
  return manager
}

// Slot writes go nowhere when there is no overlay to write to. Module-level so
// the reference is stable across renders, like a real setSlot.
const discardSlot: OverlaySlotControls['setSlot'] = () => {}

/**
 * The overlay manager where one exists, `null` where it does not.
 *
 * For components that may render both inside the canvas overlay and on a
 * standalone surface — a tool view in a chat transcript is the case that
 * matters. `useOverlay` throwing there takes the whole route down, and the
 * overlay is an enhancement rather than something they need to function, so
 * its absence is reported as a value and the slots are simply discarded.
 */
/**
 * The published slot nodes, for the surface that paints them.
 *
 * Deliberately not reachable through `useOverlay`: reading these means
 * re-rendering on every publish, which is correct for the painter and wrong for
 * everyone else.
 */
export function useOverlaySlotValues(): OverlaySlotValues {
  return useContext(OverlaySlotValuesContext)
}

export function useOptionalOverlay(nodes?: OverlaySlotNodes): OverlayManager | null {
  const manager = useContext(OverlayManagerContext)
  const setSlot = manager?.slots.setSlot ?? discardSlot
  useManagedSlot('header', nodes, setSlot)
  useManagedSlot('content', nodes, setSlot)
  useManagedSlot('menu', nodes, setSlot)
  useManagedSlot('bar', nodes, setSlot)
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
      history.pushState({ overlayBackTrap: true }, '')
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
        async handler() {
          pushedRef.current = false
          onCloseRef.current()
        },
      })
    }

    nav.addEventListener('navigate', onNavigate)
    return () => {
      nav.removeEventListener('navigate', onNavigate)
      // Only unwind the trap entry while it's still the current entry. A forward
      // navigation (clicking a link) buries it in the back-stack and replaces
      // the current entry's state, so calling history.back() here would revert
      // that navigation instead of removing the trap.
      const onTrap = pushedRef.current && history.state?.overlayBackTrap === true
      pushedRef.current = false
      if (onTrap) {
        history.back()
      }
    }
  }, [active])
}

export { useBackIntercept as useOverlayBackIntercept }
