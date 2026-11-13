// Click cycling: clicking the same spot again selects the next node down the
// stack under the pointer, so a section under a node, or a section inside
// another, can be selected without moving anything out of the way.
//
// Pure: the canvas wires it up in use-click-cycle.ts.

/**
 * How far, in screen pixels, a click may land from the one before and still
 * count as the same spot, and how far the pointer may wander between them.
 * The mouse value sits inside the double-click slop of desktop platforms
 * (4 px on Windows, 5 px in GTK); the touch value is the slop the canvas
 * already allows a finger before a long press stops counting.
 */
export const MOUSE_SLOP_PX = 4
export const TOUCH_SLOP_PX = 10

export function slopFor(pointerType: string): number {
  return pointerType === 'touch' || pointerType === 'pen' ? TOUCH_SLOP_PX : MOUSE_SLOP_PX
}

/** A node's box in flow coordinates, as the canvas draws it. */
export interface StackedBox {
  id: string
  x: number
  y: number
  width: number
  height: number
  /** A frame (a section) is drawn behind every other node. */
  frame: boolean
  /** How many frames the node is in: 0 at the top level. */
  depth: number
  zIndex: number
}

/**
 * The nodes whose box holds `point`, topmost first. `boxes` come in the
 * order the canvas draws them, later over earlier. Frames come after every
 * other node, and the deeper of two frames first, so a frame comes before the
 * frames it is in. Other nodes go by their z-index. Otherwise the one drawn
 * later comes first.
 */
export function stackAt(boxes: readonly StackedBox[], point: { x: number; y: number }): string[] {
  const hit = boxes
    .map((box, order) => ({ box, order }))
    .filter(
      ({ box }) => point.x >= box.x && point.y >= box.y && point.x < box.x + box.width && point.y < box.y + box.height,
    )
  hit.sort((p, q) => {
    if (p.box.frame !== q.box.frame) {
      return p.box.frame ? 1 : -1
    }
    const above = p.box.frame ? q.box.depth - p.box.depth : q.box.zIndex - p.box.zIndex
    return above !== 0 ? above : q.order - p.order
  })
  return hit.map(({ box }) => box.id)
}

/**
 * A cycle under way: where it was clicked (screen pixels), the stack found
 * there on its first click, and which of it is selected. The stack is kept
 * rather than found again, because selecting a node lifts it above the rest.
 */
export interface Cycle {
  x: number
  y: number
  slop: number
  stack: string[]
  index: number
}

export interface NodeClick {
  /** Screen pixels. */
  x: number
  y: number
  slop: number
  /** The node the click landed on, which React Flow has just selected. */
  nodeId: string
  /** Whether the click may cycle at all (see `isPlainClick`). */
  plain: boolean
  /** Whether the click selects text (see `selectsText`). */
  selectsText: boolean
  /** The nodes selected when the click landed, before React Flow's own selection of `nodeId`. */
  selectedIds: readonly string[]
}

/**
 * What a click on a node does to the cycle: the cycle it leaves, and the node
 * to select instead of the one React Flow picked, if any.
 *
 * A plain click within the slop of the cycle's last one, while the selection
 * is still the node the cycle selected, selects the next node down its stack,
 * wrapping to the top after the bottom. Any other plain click starts a cycle
 * at the node clicked, keeping React Flow's selection; `stackUnder` is asked
 * for the stack only then. A click that is not plain ends the cycle. A plain
 * click that selects text leaves the cycle as it is, so the click after a
 * double-click on a word selects the next node down.
 */
export function clickCycle(
  cycle: Cycle | null,
  click: NodeClick,
  stackUnder: () => string[],
): { cycle: Cycle | null; select?: string } {
  if (!click.plain) {
    return { cycle: null }
  }
  if (click.selectsText) {
    return { cycle }
  }
  if (
    cycle &&
    cycle.stack.length > 1 &&
    near(cycle, click.x, click.y) &&
    click.selectedIds.length === 1 &&
    click.selectedIds[0] === cycle.stack[cycle.index]
  ) {
    const index = (cycle.index + 1) % cycle.stack.length
    return { cycle: { ...cycle, index }, select: cycle.stack[index] }
  }
  const found = stackUnder()
  const at = found.indexOf(click.nodeId)
  // Starting from the node clicked keeps the order around the stack, if the
  // node React Flow found under the pointer is not the one drawn on top.
  const stack = at < 0 ? [click.nodeId] : [...found.slice(at), ...found.slice(0, at)]
  return { cycle: { x: click.x, y: click.y, slop: click.slop, stack, index: 0 } }
}

/** Whether the pointer, at (`x`, `y`) in screen pixels, has left the spot the cycle was clicked at. */
export function movedAway(cycle: Cycle, x: number, y: number): boolean {
  return !near(cycle, x, y)
}

function near(cycle: Cycle, x: number, y: number): boolean {
  return Math.hypot(x - cycle.x, y - cycle.y) <= cycle.slop
}

/**
 * What inside a node handles its own clicks: form controls and links, edge
 * handles and a frame's resize controls. A repeated click there is the
 * content's (a button pressed twice), not a step down the stack. A node's
 * body marked `nodrag` (a window's content, which a press scrolls or selects
 * text in rather than drags) is not among them: a click there selects the
 * node like any other.
 */
const OWN_CLICKS = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '.react-flow__handle',
  '.react-flow__resize-control',
].join(', ')

/**
 * Content that selects text itself and leaves the document's selection
 * empty: an xterm terminal, whose root element the xterm library classes
 * `xterm` in whichever node embeds it.
 */
const OWN_TEXT_SELECTION = '.xterm'

interface ClickEventLike {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  /** The click's count within a quick burst: 2 and up for a double or triple click. */
  detail: number
  target: EventTarget | null
}

/**
 * Whether a click on `node` (its React Flow wrapper element) may cycle: no
 * modifier key (Shift adds to the selection), and not on the node's content
 * that handles its own clicks. Clicks in quick succession cycle like slow
 * ones: the canvas gives a double-click on a node no action of its own.
 *
 * The node's own content is inside its element, or drawn elsewhere through a
 * portal (its touch resize handles), whose clicks React passes up through the
 * node. An element the node is drawn inside is not the node's content.
 */
export function isPlainClick(event: ClickEventLike, node: Element): boolean {
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
    return false
  }
  const own = event.target instanceof Element ? event.target.closest(OWN_CLICKS) : null
  return !(own && !own.contains(node))
}

/**
 * Whether a click on `node` selects text, as a double or triple click on text
 * selects a word or a line: a repeated click of a quick burst, in a terminal
 * or on an element that holds part of the document's selection.
 */
export function selectsText(event: ClickEventLike, node: Element): boolean {
  // A single click selects no text. One on text already selected clears it,
  // but the browser clears it only after the click, so the selection is still
  // there when the click lands.
  const target = event.target instanceof Element ? event.target : null
  if (!target || event.detail < 2) {
    return false
  }
  if (target.closest(OWN_TEXT_SELECTION)) {
    return true
  }
  // Only a selection on the element clicked counts: text left selected in a
  // window's body stays selected through clicks on the window's title bar.
  const text = node.ownerDocument.getSelection()
  return Boolean(text && !text.isCollapsed && text.getRangeAt(0).intersectsNode(target))
}
