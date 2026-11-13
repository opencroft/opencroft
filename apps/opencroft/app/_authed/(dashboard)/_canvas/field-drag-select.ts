// A mouse drag that selects text in a field on a node card, and leaves the
// card while it selects.
//
// Chromium resolves where such a selection ends by mapping the pointer into
// the field's own coordinates, and under a CSS transform on an ancestor it
// maps a point outside the field past the field's end. React Flow transforms
// both the viewport and every node, so on the canvas a drag that leaves the
// field towards its start selects to its end without the capture. WebKit does
// the same.
// Firefox does not, nor does Chromium for a field with no transformed
// ancestor (measured with Playwright 1.56.1, Chromium, Firefox and WebKit, on a
// static page with and without the transforms). With the pointer captured by
// the field, Chromium resolves the point against the field itself and the
// selection follows the pointer as it does anywhere else on the page.
//
// Tripwire: if a press in a canvas field, dragged out of the node to the left,
// selects to the start of the text with this handler removed, the browser no
// longer needs it.

import type { PointerEvent as ReactPointerEvent } from 'react'

// Fields that select text by dragging: text inputs and text areas. Inputs that
// are a control rather than text (a checkbox, a slider) are left out, and so is
// editable content: capturing its editing host would send the release, and with
// it the click, to the host instead of to a control inside it.
const TEXT_FIELD = [
  'textarea',
  'input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="reset"], [type="file"], [type="color"], [type="image"])',
].join(', ')

/**
 * For the canvas element's `onPointerDownCapture`: a primary mouse press in a
 * text field on a node gives the field the pointer until it is released, so a
 * drag selecting text there keeps selecting outside the node. The release
 * ends the capture wherever it happens, outside the window included. A touch
 * or a pen is left alone, and so is a press on a field drawn elsewhere through
 * a portal, which React bubbles through the canvas.
 */
export function captureFieldDragSelect(event: ReactPointerEvent<HTMLElement>): void {
  const target = event.target
  if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary || !(target instanceof Element)) {
    return
  }
  const field = target.closest(TEXT_FIELD)
  const node = field?.closest('.react-flow__node')
  if (!field || !node || !event.currentTarget.contains(node)) {
    return
  }
  field.setPointerCapture(event.pointerId)
}
