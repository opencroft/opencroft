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
  const text = startsInside && endsInside ? selection.toString() : readClamped(root, range, selection, startsInside, endsInside)
  return text.trim() ? text : ''
}

function readClamped(
  root: Node,
  range: Range,
  selection: Selection,
  startsInside: boolean,
  endsInside: boolean,
): string {
  const clamped = range.cloneRange()
  if (!startsInside) {
    clamped.setStart(root, 0)
  }
  if (!endsInside) {
    clamped.setEnd(root, root.childNodes.length)
  }
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection
  selection.removeAllRanges()
  selection.addRange(clamped)
  const text = selection.toString()
  selection.removeAllRanges()
  if (anchorNode && focusNode) {
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
  }
  return text
}
