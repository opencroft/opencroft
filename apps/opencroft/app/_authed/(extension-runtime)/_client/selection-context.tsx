'use client'

// The scoped selection a surface offers its chat composer.
//
// The host mounts a scope around every App page and around the canvas, so a
// surface publishes into the scope already around it: `usePublishSelection`
// with what the reader has selected, or `useSelection().setSelection(...)` from
// an event. The chat composer inside the same scope quotes the selection and,
// while passing is on, prefixes the outgoing message with its content (see
// message-envelope.ts's wrapUserSelection).
//
// A SURFACE PUBLISHES ITEMS; THE SCOPE COMPOSES. A `Selection` is a list of
// references, and the scope turns it into the quote and the block once, when
// it is published (selection-envelope.ts's describeSelection), naming the
// space and the place from the route that mounted it. What it holds, shares
// and sends is that composed `{label, content}` pair. A publisher may
// hand over a pair of its own; it is passed through as it is.
//
// THE SELECTION IS SCOPED TO THE MOUNTED PROVIDER, BY CONSTRUCTION. It lives in
// the provider component itself, so navigating away unmounts it and the
// selection is gone with it — there is nothing app-global to clear. One
// selection per mounted scope; a new `setSelection` replaces the old one (last
// write wins).
//
// A PROVIDER INSIDE A SCOPE ADDS NO SECOND SCOPE. It renders its children into
// the one above, so an extension that wraps its surface in its own
// `SelectionProvider` publishes into the host's scope rather than hiding its
// selection from a composer outside its wrap. What it published is cleared
// when it unmounts.
//
// AND IT REACHES THE SAME SPACE'S SCOPES IN THE BROWSER'S OTHER WINDOWS. Inside
// a `SelectionSpace`, the scope publishes what its surface selects on a
// BroadcastChannel and shows the newest selection any window of that space
// made, so a chat in its own window quotes the canvas or the document open in
// another. The rules are in selection-broadcast.ts. Unmounting, and the window
// going away (`pagehide`), clear what the scope published from the windows
// showing it. Outside a `SelectionSpace` the scope is this window's alone.
//
// TWO INDEPENDENT PIECES OF STATE. What is selected, and whether selections are
// passed. Neither reads the other: a publisher setting a selection does not
// touch the flag, and the flag can be set with nothing selected at all. That
// independence is the contract rather than an implementation detail — see the
// note on `passEnabled`. They also differ in lifetime: the selection belongs to
// the surface, the flag to the reader, so only the flag outlives the provider.

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { describeSelection, isSelection, type Selection } from '@/app/_authed/(agent)/_shared/selection-envelope'
import {
  openBroadcastPort,
  openSelectionBridge,
  type RemoteSelection,
  type SelectionBridge,
  type StampedSelection,
  shownSelection,
  thisWindowSource,
} from '@/app/_authed/(extension-runtime)/_client/selection-broadcast'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'

// One value per browser, like the chat dock's own arrangement keys: the answer
// is the reader's about selections in general, and the provider sits above any
// one chat, so there is no narrower owner to key it by.
export const PASS_ENABLED_KEY = 'opencroft.selection.passEnabled'

/** A selection as the scope holds it: composed, or handed over whole by a publisher. */
export interface UserSelection {
  /**
   * What the quote shows. For a composed selection it is the block's first
   * line too, so the delivered message shows the same quote.
   */
  label: string
  /** What the agent receives when passing is on. */
  content: string
}

/** What a publisher hands the scope: items to compose, or a pair it composed itself. */
export type PublishedSelection = Selection | UserSelection

export interface SelectionContextValue {
  /**
   * The current selection, or null when nothing is selected: the newest one
   * made in this window or, inside a `SelectionSpace`, in another window of
   * the same space.
   */
  selection: UserSelection | null
  /**
   * Whether a selection rides along with the next message.
   *
   * A STANDING PREFERENCE OF THE READER, not a property of what is selected.
   * Setting a selection does not touch it, and it can be set with nothing
   * selected at all — the control that reads it stands on the panel whether or
   * not there is anything to hide, so its own state is the notice that passing
   * is off, and the reader's answer stands until the reader changes it.
   *
   * It is kept in `localStorage`, so it also survives a reload, navigating
   * away and back, and the provider remounting.
   */
  passEnabled: boolean
  /**
   * Replace the selection (last write wins). A `Selection` is composed here;
   * one with no items, and `null`, clear it.
   */
  setSelection: (selection: PublishedSelection | null) => void
  /**
   * Drop the selection entirely. For a publisher that has stopped publishing —
   * a view navigating off the thing it was offering. There is no reader-facing
   * control for this; holding a selection back is what a reader does, and that
   * is `togglePass`.
   */
  clearSelection: () => void
  /** Flip whether selections are passed with the next message. */
  togglePass: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

/**
 * The id of the space the surface below shows. A `SelectionProvider` inside it
 * shares its selection with the same space's scopes in the browser's other
 * windows; one outside it keeps its selection to this window.
 */
export const SelectionSpace = createContext<string | null>(null)

function sameSelection(a: UserSelection | null, b: UserSelection | null): boolean {
  return a === b || (a !== null && b !== null && a.label === b.label && a.content === b.content)
}

export interface SelectionProviderProps {
  /** The space's name, the quote's first part. Given by the route that mounts the scope. */
  spaceName?: string
  /** Where the reader is, the quote's second part when a selection names no place: the App's name. */
  place?: string
  children: ReactNode
}

export function SelectionProvider(props: SelectionProviderProps) {
  const outer = useContext(SelectionContext)
  return outer ? <NestedScope outer={outer}>{props.children}</NestedScope> : <Scope {...props} />
}

/**
 * A provider inside a scope: the scope above, with what this provider's
 * surface published cleared when it unmounts. It clears only when its own last
 * publish was a selection with something in it, so a nested surface that never
 * published, already cleared or published an empty list leaves alone what
 * another surface put in the scope.
 */
function NestedScope({ outer, children }: { outer: SelectionContextValue; children: ReactNode }) {
  const holds = useRef(false)
  const { setSelection: setOuter, clearSelection: clearOuter } = outer
  const setSelection = useCallback(
    (next: PublishedSelection | null) => {
      holds.current = holdsSomething(next)
      setOuter(next)
    },
    [setOuter],
  )
  const clearSelection = useCallback(() => setSelection(null), [setSelection])
  useEffect(
    () => () => {
      if (holds.current) {
        holds.current = false
        clearOuter()
      }
    },
    [clearOuter],
  )
  const value = useMemo<SelectionContextValue>(
    () => ({ ...outer, setSelection, clearSelection }),
    [outer, setSelection, clearSelection],
  )
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

/** Whether publishing `selection` puts something in the scope, rather than clearing it. */
function holdsSomething(selection: PublishedSelection | null): boolean {
  return selection !== null && !(isSelection(selection) && selection.items.length === 0)
}

function Scope({ spaceName, place, children }: SelectionProviderProps) {
  // Publishing writes the selection and nothing else. There is deliberately no
  // branch here that reads `passEnabled` or writes it: whatever a publisher
  // does, the reader's answer about passing is theirs and stays where they left
  // it.
  //
  // This window's selection and the other windows' are kept apart, and what is
  // shown is derived from both: a clear from another window can then never
  // erase this window's own selection, and nothing received is ever posted.
  const [local, setLocal] = useState<StampedSelection | null>(null)
  const [remote, setRemote] = useState<RemoteSelection | null>(null)
  const [passEnabled, setPassEnabled] = useLocalStorage<boolean>(PASS_ENABLED_KEY, true)
  const space = useContext(SelectionSpace)

  // The names are read when a selection is published, not kept in the
  // setter's identity: publishers list the setter in their effects'
  // dependencies, and a renamed App would otherwise republish everything.
  const names = useRef({ space: spaceName, place })
  names.current = { space: spaceName, place }

  // Stamped only when the selection really changes. A publisher republishing
  // what it already holds (an effect re-running on a fresh object) is not the
  // reader selecting anything, and a new time would make it outrank a newer
  // selection from another window. The identity is stable: publishers list it
  // in their effects' dependencies, and a new identity would re-run them.
  const setSelection = useCallback((next: PublishedSelection | null) => {
    const composed = next && isSelection(next) ? describeSelection(next, names.current) : next
    setLocal((prev) =>
      sameSelection(prev?.selection ?? null, composed) ? prev : { selection: composed, at: Date.now() },
    )
  }, [])
  const clearSelection = useCallback(() => setSelection(null), [setSelection])
  const togglePass = useCallback(() => setPassEnabled((prev) => !prev), [setPassEnabled])

  useSelectionBroadcast(space, local, setRemote)

  const selection = shownSelection(local, remote)
  const value = useMemo<SelectionContextValue>(
    () => ({ selection, passEnabled, setSelection, clearSelection, togglePass }),
    [selection, passEnabled, setSelection, clearSelection, togglePass],
  )
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}

/**
 * Connects a scope to the same space's scopes in the browser's other windows,
 * while it has a space and the browser has the channel.
 *
 * Driven from state, not from `setSelection`: a publisher's mount effect runs
 * before this one, so a post made inside the setter would go out before the
 * channel exists. Opening offers whatever is selected by then, and every later
 * change is posted as it lands.
 */
function useSelectionBroadcast(
  space: string | null,
  local: StampedSelection | null,
  onRemote: (remote: RemoteSelection | null) => void,
) {
  const bridgeRef = useRef<SelectionBridge | null>(null)
  const localRef = useRef(local)
  localRef.current = local

  useEffect(() => {
    if (!space || typeof BroadcastChannel === 'undefined') {
      return
    }
    const bridge = openSelectionBridge({
      space,
      source: thisWindowSource(),
      open: openBroadcastPort,
      now: Date.now,
      onRemote,
      local: localRef.current,
    })
    bridgeRef.current = bridge
    bridge.announce()

    // Leaving clears this window's selection from the others; coming back
    // from the back-forward cache asks again, since what they hold may have
    // changed while this page was frozen.
    const onPageHide = () => bridge.leave()
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        bridge.rejoin()
      }
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      bridge.leave()
      bridge.close()
      bridgeRef.current = null
      onRemote(null)
    }
  }, [space, onRemote])

  useEffect(() => {
    bridgeRef.current?.publish(local)
  }, [local])
}

/**
 * The selection scope this component sits in. Throws outside a provider —
 * calling it there is a wiring mistake, and a silent no-op would read as
 * "selection doesn't work" instead of saying what is missing.
 */
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (!ctx) {
    throw new Error('useSelection must be called inside a SelectionProvider')
  }
  return ctx
}

/**
 * The selection scope, or null when none is mounted. For surfaces that render
 * both with and without one — the shared chat composer uses this so the same
 * component serves the extension surface (badge shown) and the thread route of
 * a chat that is no space's (no provider, no badge).
 */
export function useOptionalSelection(): SelectionContextValue | null {
  return useContext(SelectionContext)
}

/**
 * Publish what the surface has selected, declaratively: the scope gets
 * `selection` whenever its value changes, and a clear on `null`, on an empty
 * list and when the calling component unmounts holding a selection.
 *
 * Compared by value, so a selection built afresh on every render publishes
 * once. Outside a scope it does nothing: a surface that renders with and
 * without a chat around it (the canvas on a dashboard) publishes where there
 * is somewhere to publish to.
 */
export function usePublishSelection(selection: PublishedSelection | null): void {
  const setSelection = useOptionalSelection()?.setSelection
  const key = selection === null ? null : JSON.stringify(selection)
  const latest = useRef(selection)
  latest.current = selection

  // Whether the last value published put something in the scope: only then is
  // there anything of this publisher's to clear when it goes.
  const holds = useRef(false)

  useEffect(() => {
    // `key` stands for `latest.current`'s value, which is what is published.
    void key
    if (setSelection) {
      holds.current = holdsSomething(latest.current)
      setSelection(latest.current)
    }
  }, [setSelection, key])

  // Its own effect, so a change of value is a replacement rather than a clear
  // followed by a set; it runs only when the publisher goes or the scope does.
  useEffect(
    () => () => {
      if (holds.current) {
        holds.current = false
        setSelection?.(null)
      }
    },
    [setSelection],
  )
}
