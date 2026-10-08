import type { PointerEvent } from 'react'

/**
 * Keep a mouse drag that started in a sideways-scrolling box on the box's own
 * rows. Call it from the press, with the box that scrolls.
 *
 * A drag past the box's edge scrolls the box, but the browser takes the
 * selection's end from whatever element is under the pointer. Beside a box
 * that is often not part of it -- a timeline rail, a scrollbar, a page's
 * margin -- and then the selection jumps out of the box, or stops while the
 * box keeps scrolling under it. While the pointer is beside the box, level
 * with it, two things keep it on the row:
 *
 * - The box captures the pointer, so its moves land on the box and the
 *   browser scrolls the box, not whatever scrolls around it. Only from there,
 *   not from the press: the release of a captured pointer, and the click after
 *   it, go to the box, so a link or a button in the box would stop working.
 * - Every frame puts the selection's end back on the character at the edge
 *   the pointer left by. The browser's autoscroll moves it each frame from a
 *   fresh look at what is under the pointer, which capture does not change,
 *   so a pointer held still beside the box would otherwise leave the
 *   selection on the neighbour.
 *
 * Back over the box, or above or below it, the capture is let go and the
 * frames do nothing, so a selection runs on into the text around it as it
 * does anywhere else. A press outside the box, or by touch or another button,
 * is left alone: touch selects with handles, not a drag.
 */
export function keepDragInScrollBox(event: PointerEvent<HTMLElement>, box: HTMLElement | null) {
  if (event.pointerType !== 'mouse' || event.button !== 0 || !box?.contains(event.target as Node)) {
    return
  }
  const pointer = event.pointerId
  let { clientX: x, clientY: y } = event
  let frame = 0
  const follow = (move: { pointerId: number; clientX: number; clientY: number }) => {
    if (move.pointerId !== pointer) {
      return
    }
    x = move.clientX
    y = move.clientY
    // A box re-rendered mid-drag has left the document, and a pointer cannot
    // be captured by an element that is no longer in it.
    if (!box.isConnected) {
      release()
      return
    }
    const { top, bottom, left, right } = box.getBoundingClientRect()
    const beside = y >= top && y <= bottom && (x < left || x > right)
    if (beside === box.hasPointerCapture(pointer)) {
      return
    }
    if (beside) {
      box.setPointerCapture(pointer)
    } else {
      box.releasePointerCapture(pointer)
    }
  }
  const holdTheEnd = () => {
    frame = requestAnimationFrame(holdTheEnd)
    if (!box.isConnected) {
      release()
      return
    }
    const { top, bottom, left, right } = box.getBoundingClientRect()
    if (y < top || y > bottom || (x >= left && x <= right)) {
      return
    }
    // The point is taken inside the box's own border. A point on the border
    // put the end after the box's last row rather than on the pointer's row.
    const inner = left + box.clientLeft
    const caret = caretAt(Math.min(Math.max(x, inner + 1), inner + box.clientWidth - 1), y)
    const selection = window.getSelection()
    // Off the box's text -- under a control laid over it -- the browser's own
    // answer stands.
    if (caret && box.contains(caret.node) && selection?.rangeCount) {
      selection.extend(caret.node, caret.offset)
    }
  }
  const release = () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', follow, true)
    window.removeEventListener('pointerup', release, true)
    window.removeEventListener('pointercancel', release, true)
  }
  window.addEventListener('pointermove', follow, true)
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  frame = requestAnimationFrame(holdTheEnd)
}

/** The text position at a point in the viewport, from whichever API the browser has. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(x, y)
    return position && { node: position.offsetNode, offset: position.offset }
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}
