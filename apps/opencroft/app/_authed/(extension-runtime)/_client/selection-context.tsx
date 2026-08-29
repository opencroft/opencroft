'use client'

// The scoped selection a surface offers its chat composer.
//
// An extension wraps a surface (a dashboard, a page) in `SelectionProvider`
// and calls `useSelection().setSelection(...)` as the reader selects things.
// The chat composer inside the same provider shows the selection as a badge
// and, while passing is on, prefixes the outgoing message with the selection's
// content (see message-envelope.ts's wrapUserSelection).
//
// THE SCOPE IS THE MOUNTED PROVIDER, BY CONSTRUCTION. State lives in the
// provider component itself, so navigating away unmounts it and the selection
// is gone with it — there is nothing app-global to clear and no store that
// could outlive the surface. One selection per mounted scope; a new
// `setSelection` replaces the old one (last write wins).

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export interface UserSelection {
  /** What the badge shows. Presentation only — never sent to the agent. */
  label: string
  /** What the agent receives when passing is on. */
  content: string
  /**
   * What makes this the SAME selection across republishes, when the publisher
   * has such a notion. Optional, and absent means every publish is a new
   * selection — which is the behaviour this had before the field existed.
   *
   * It exists for a publisher that republishes live content for one thing: a
   * canvas node whose data changes on its own while it stays selected. Without
   * it, each refresh reads as a fresh selection and resets `passEnabled`, so a
   * reader who turned passing OFF has it turned back on by something they did
   * not do — and the next message carries what they declined to send.
   */
  key?: string
}

export interface SelectionContextValue {
  /** The current selection, or null when nothing is selected. */
  selection: UserSelection | null
  /** Whether the selection rides along with the next message. Toggled from
   *  the badge; reset to true whenever a new selection is set — selecting
   *  something is the statement of intent to pass it. */
  passEnabled: boolean
  /** Replace the selection (last write wins). `null` clears it. */
  setSelection: (selection: UserSelection | null) => void
  /** Drop the selection entirely — the badge's X. */
  clearSelection: () => void
  /** Flip whether the selection is passed with the next message. */
  togglePass: () => void
}

const SelectionContext = createContext<SelectionContextValue | null>(null)

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selection, setSelectionState] = useState<UserSelection | null>(null)
  const [passEnabled, setPassEnabled] = useState(true)

  const setSelection = useCallback((next: UserSelection | null) => {
    setSelectionState((current) => {
      // A fresh selection passes by default: setting one is the intent to use
      // it, and inheriting a stale "off" from a previous selection would make
      // the badge silently inert.
      //
      // A republish of the SAME selection is not a fresh one, and must leave
      // the reader's choice alone. Only a keyed publisher can say the two
      // apart; without a key every publish is fresh, exactly as before.
      const sameThing = next !== null && current !== null && next.key !== undefined && next.key === current.key
      if (!sameThing) {
        setPassEnabled(true)
      }
      return next
    })
  }, [])
  const clearSelection = useCallback(() => setSelectionState(null), [])
  const togglePass = useCallback(() => setPassEnabled((prev) => !prev), [])

  const value = useMemo<SelectionContextValue>(
    () => ({ selection, passEnabled, setSelection, clearSelection, togglePass }),
    [selection, passEnabled, setSelection, clearSelection, togglePass],
  )
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
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
 * component serves the extension surface (badge shown) and the plain thread
 * route (no provider, no badge).
 */
export function useOptionalSelection(): SelectionContextValue | null {
  return useContext(SelectionContext)
}
