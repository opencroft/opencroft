// What the canvas asks of a node's content before it hands it a wheel or a
// touch: whether something under the pointer can scroll.

export const NODE = '.react-flow__node'
// The element xyflow attaches its d3-zoom to.
export const ZOOM_PANE = '.react-flow__renderer'
const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

/**
 * The attribute content sets on itself while it scrolls itself without a
 * native scroll container, such as a terminal app that reads the wheel as keys
 * or mouse reports. Inside a selected node it counts as content that can
 * scroll, on either axis. Documented for node bodies on
 * `NodeDefinition.component`.
 */
export const SCROLLS_ITSELF = 'data-scrolls-itself'

/**
 * Whether an element of `node`'s content at the point (`x`, `y`) can scroll
 * on the given axis: it overflows on it, or carries `SCROLLS_ITSELF`. Every
 * element hit at the point counts, not only the target's ancestors: a
 * terminal's scrolling viewport is a sibling of the screen the pointer lands
 * on.
 */
export function contentScrollsAt(node: Element, x: number, y: number, vertical: boolean): boolean {
  for (const el of node.ownerDocument.elementsFromPoint(x, y)) {
    if (el === node || !node.contains(el)) {
      continue
    }
    if (el.hasAttribute(SCROLLS_ITSELF)) {
      return true
    }
    const style = getComputedStyle(el)
    if (!SCROLLING_OVERFLOW.has(vertical ? style.overflowY : style.overflowX)) {
      continue
    }
    if (vertical ? el.scrollHeight > el.clientHeight : el.scrollWidth > el.clientWidth) {
      return true
    }
  }
  return false
}
