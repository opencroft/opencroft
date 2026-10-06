// Which key presses the canvas's own shortcuts may act on.
//
// The answer is an allow-list, not a deny-list: a press belongs to the canvas
// only when it lands on the canvas element or inside it, and even then not when
// it lands in something that edits text. Everything else on the page -- the
// inspector, dialogs, chats, the documentation editor -- keeps the browser's
// behaviour without having to be recognised as an editor first.
//
// That matters because "is this an editor" cannot be answered from the focused
// element alone. Monaco takes input through the EditContext API on a plain div,
// which is neither a form field nor contenteditable, so a guard that knows only
// those would read a focused code editor as "not editing" and take its paste.

import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react'

// Elements that edit text, and `.nokey`: @xyflow/react's own opt-out from its
// key handling, which the host code editor carries for the same reason.
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .nokey'

/** True when `event` was pressed on `canvas` itself or inside it, outside any text editor. */
export function isCanvasKeyPress(event: KeyboardEvent, canvas: Element): boolean {
  const target = event.target
  if (!(target instanceof Element) || !canvas.contains(target)) {
    return false
  }
  return target.closest(EDITABLE) === null
}

/**
 * For the canvas element's `onPointerDownCapture`: pressing the canvas gives it
 * keyboard focus, so its shortcuts work right after a click on the pane or a
 * node, and stop as soon as the user clicks into an editor elsewhere.
 *
 * Focus is moved here rather than left to the press's default action, because
 * the pane cancels that default for a selection drag started over a node. A press
 * on something focusable inside the canvas still focuses that element
 * afterwards, as usual. Presses from portalled content, which React bubbles
 * through the canvas without it being under the canvas on the page, are left
 * alone.
 */
export function focusCanvasOnPress(event: ReactPointerEvent<HTMLElement>): void {
  const canvas = event.currentTarget
  const target = event.target
  if (!(target instanceof Node) || !canvas.contains(target) || canvas.contains(canvas.ownerDocument.activeElement)) {
    return
  }
  canvas.focus({ preventScroll: true })
}

/**
 * For the canvas element's `onDrop`, once the drop adds a node: a drop is not a
 * press, so focusCanvasOnPress never runs for it. Focus would stay on the
 * palette button the node came from, and a Ctrl+Z for the node just added would
 * never reach the canvas.
 */
export function focusCanvasOnDrop(event: ReactDragEvent<HTMLElement>): void {
  event.currentTarget.focus({ preventScroll: true })
}

/**
 * Hands keyboard focus to `canvas` when the element holding it inside `editor`
 * -- the canvas and the inspector beside it -- is removed. Returns the cleanup.
 *
 * Deleting the focused node, here or by someone else on a live graph, or the
 * node whose inspector has focus, removes the focused element, and the browser
 * drops focus to the page body, where no canvas shortcut reaches: a Ctrl+Z
 * straight after a Delete did nothing. Focus the user moved elsewhere, on the
 * page or off it, is left alone.
 */
export function keepFocusOnCanvas(editor: HTMLElement, canvas: HTMLElement): () => void {
  const doc = editor.ownerDocument
  let holder: Element | null = null

  const onFocusIn = (event: FocusEvent) => {
    holder = event.target instanceof Element ? event.target : null
  }
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget
    if (next instanceof Node && editor.contains(next)) {
      return
    }
    if (next !== null) {
      holder = null
      return
    }
    // Focus going nowhere: a click on the page, or the element's removal.
    // Only the removal leaves it off the page.
    const left = event.target
    queueMicrotask(() => {
      if (holder !== null && holder === left && holder.isConnected) {
        holder = null
      }
    })
  }
  const observer = new MutationObserver(() => {
    if (!holder || holder.isConnected) {
      return
    }
    holder = null
    if (doc.activeElement === null || doc.activeElement === doc.body) {
      canvas.focus({ preventScroll: true })
    }
  })

  editor.addEventListener('focusin', onFocusIn)
  editor.addEventListener('focusout', onFocusOut)
  observer.observe(editor, { childList: true, subtree: true })
  return () => {
    editor.removeEventListener('focusin', onFocusIn)
    editor.removeEventListener('focusout', onFocusOut)
    observer.disconnect()
  }
}

/** True when the user has selected text inside `canvas`, which a copy should copy as text. */
export function hasTextSelectionIn(canvas: Element): boolean {
  const selection = canvas.ownerDocument.getSelection()
  if (!selection || selection.isCollapsed || selection.toString() === '') {
    return false
  }
  return canvas.contains(selection.anchorNode)
}
