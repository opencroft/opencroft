/**
 * Marks an element that stands for a piece of text it does not render as
 * selectable text -- a chip drawn for an identifier. A selection reads it as
 * the attribute's value instead of what it shows.
 */
export const SELECTION_TEXT_ATTRIBUTE = 'data-selection-text'

const STAND_IN = `[${SELECTION_TEXT_ATTRIBUTE}]`

// The part of the reader's selection that lies inside one message.
//
// Returns '' when nothing selected falls inside `root` -- no selection, a
// collapsed one, one entirely elsewhere, or one that covers only whitespace
// here -- so a caller can fall back to the whole message on one check.
//
// A selection that runs across several messages is cut to this one: its ends
// are clamped to `root`'s own bounds. Only the first range is read; a browser
// that keeps several (Firefox, with Ctrl) is choosing an unusual gesture, and
// its first range is still inside what the reader selected.
//
// The text is the browser's own serialisation of a selection -- what Ctrl+C
// would put on the clipboard, with a line break between paragraphs and list
// items -- rather than the range's `toString()`, which runs the text of
// adjacent blocks together. A clamped range has no serialisation of its own,
// so it is selected for the one read and the reader's selection is put back
// exactly as it was, direction included, before anything can paint.
//
// An element carrying SELECTION_TEXT_ATTRIBUTE reads as that attribute's
// value, whole, wherever the selection touches it.
export function selectedTextWithin(root: Node, selection: Selection | null): string {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return ''
  }
  const range = selection.getRangeAt(0)
  if (!range.intersectsNode(root)) {
    return ''
  }
  const startsInside = root.contains(range.startContainer)
  const endsInside = root.contains(range.endContainer)
  const clamped = startsInside && endsInside ? range : clampTo(root, range, startsInside, endsInside)
  const text = hasStandIn(root, clamped)
    ? readWithStandIns(clamped, selection)
    : clamped === range
      ? selection.toString()
      : readSelected(clamped, selection)
  return text.trim() ? text : ''
}

function clampTo(root: Node, range: Range, startsInside: boolean, endsInside: boolean): Range {
  const clamped = range.cloneRange()
  if (!startsInside) {
    clamped.setStart(root, 0)
  }
  if (!endsInside) {
    clamped.setEnd(root, root.childNodes.length)
  }
  return clamped
}

function hasStandIn(root: Node, range: Range): boolean {
  const scope = root as Partial<ParentNode>
  if (!scope.querySelectorAll) {
    return false
  }
  return [...scope.querySelectorAll(STAND_IN)].some((element) => range.intersectsNode(element))
}

// A stand-in cannot be read in place: a browser leaves an unselectable element
// out of a selection's text, and puts a line break where an inline-flex box
// sat. So the selected content is copied, each stand-in is replaced by its
// text, and the copy is read off-screen the same way the selection would be.
function readWithStandIns(range: Range, selection: Selection): string {
  const document = range.startContainer.ownerDocument ?? (range.startContainer as Document)
  const fragment = range.cloneContents()
  for (const standIn of fragment.querySelectorAll(STAND_IN)) {
    standIn.replaceWith(standIn.getAttribute(SELECTION_TEXT_ATTRIBUTE) ?? '')
  }
  const copy = document.createElement('div')
  copy.setAttribute('aria-hidden', 'true')
  copy.style.cssText = 'position: fixed; top: 0; left: -100000px;'
  copy.append(fragment)
  document.body.append(copy)
  try {
    const whole = document.createRange()
    whole.selectNodeContents(copy)
    return readSelected(whole, selection)
  } finally {
    copy.remove()
  }
}

function readSelected(range: Range, selection: Selection): string {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  selection.removeAllRanges()
  selection.addRange(range)
  const text = selection.toString()
  selection.removeAllRanges()
  if (anchorNode && focusNode) {
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
  }
  return text
}
