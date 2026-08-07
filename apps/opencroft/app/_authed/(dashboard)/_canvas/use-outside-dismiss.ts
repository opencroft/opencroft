import { type RefObject, useEffect } from 'react'

// Dismiss a floating element (context menu, popover) when an interaction
// STARTS outside it -- and only then.
//
// The event to key on is `pointerdown`, and the choice is load-bearing. A
// canvas menu is typically opened mid-gesture (long-press: the finger is
// still down when the menu mounts), so the gesture that opened it ends with
// a `pointerup`/`touchend` whose target is wherever the touch STARTED -- the
// node under the finger, never the menu that did not exist yet. Any dismiss
// listener keyed on an end-of-gesture event (`touchend`, or the compatibility
// `mousedown` the browser synthesizes after a touch) therefore sees the
// opening gesture's own release as an "outside" event and closes the menu
// before a separate tap can ever reach it.
//
// `pointerdown` cannot be that release: it fires only at the START of a new
// press, the opening gesture's own pointerdown happened before this listener
// existed, and per the Pointer Events spec the compatibility mouse events
// derived from a touch do not produce additional pointer events. So the menu
// survives the gesture that opened it by construction -- no flag handshake
// with the code that opened it -- while a genuine new press outside dismisses
// it on both mouse and touch alike.
//
// Registered in the capture phase so a `stopPropagation` anywhere in the
// tree cannot hide an outside press from the dismiss decision.
export function useOutsideDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void): void {
  useEffect(() => {
    const handle = (e: PointerEvent) => {
      if (ref.current && !(e.target instanceof Node && ref.current.contains(e.target))) {
        onDismiss()
      }
    }
    document.addEventListener('pointerdown', handle, true)
    return () => document.removeEventListener('pointerdown', handle, true)
  }, [ref, onDismiss])
}
