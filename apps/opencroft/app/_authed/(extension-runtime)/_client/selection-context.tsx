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
//
// TWO INDEPENDENT PIECES OF STATE. What is selected, and whether selections are
// passed. Neither reads the other: a publisher setting a selection does not
// touch the flag, and the flag can be set with nothing selected at all. That
// independence is the contract rather than an implementation detail — see the
// note on `passEnabled`.

import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useMemo, useState } from 'react'

export interface UserSelection {
  /** What the badge shows. Presentation only — never sent to the agent. */
  label: string
  /** What the agent receives when passing is on. */
  content: string
}

export interface SelectionContextValue {
  /** The current selection, or null when nothing is selected. */
  selection: UserSelection | null
  /**
   * Whether a selection rides along with the next message.
   *
   * A STANDING PREFERENCE OF THE SCOPE, not a property of what is selected.
   * Setting a selection does not touch it, and it can be set with nothing
   * selected at all — the control that reads it stands on the panel whether or
   * not there is anything to hide.
   *
   * It used to reset to true whenever a new selection arrived, on the reasoning
   * that picking something states the intent to send it. What that protected
   * was a reader unable to tell that passing had been left off: the control
   * only existed while something was selected, so an old "off" made the
   * quotation silently inert. The control is now permanent, so its own state is
   * that notice, and the reader's answer stands until the reader changes it.
   */
  passEnabled: boolean
  /** Replace the selection (last write wins). `null` clears it. */
  setSelection: (selection: UserSelection | null) => void
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

export function SelectionProvider({ children }: { children: ReactNode }) {
  // Publishing writes the selection and nothing else. There is deliberately no
  // branch here that reads `passEnabled` or writes it: whatever a publisher
  // does, the reader's answer about passing is theirs and stays where they left
  // it. See the note on `passEnabled` for what the removed reset protected.
  const [selection, setSelection] = useState<UserSelection | null>(null)
  const [passEnabled, setPassEnabled] = useState(true)

  const clearSelection = useCallback(() => setSelection(null), [])
  const togglePass = useCallback(() => setPassEnabled((prev) => !prev), [])

  const value = useMemo<SelectionContextValue>(
    () => ({ selection, passEnabled, setSelection, clearSelection, togglePass }),
    // `setSelection` is React's own setter and its identity is stable, so it is
    // not listed. It used to be a `useCallback` of ours and had to be.
    [selection, passEnabled, clearSelection, togglePass],
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
