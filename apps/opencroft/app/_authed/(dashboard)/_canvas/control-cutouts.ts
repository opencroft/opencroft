// How a target drawn over nodes (a touch target, a resize control) leaves the
// controls it lies over their presses: its clip-path cuts a hole where each of
// them is drawn. The browser hit-tests a clipped element by its clip-path, so
// a press in a hole reaches the control under it, and a press anywhere else in
// the target is the target's.

/** What a finger taps in a node: its buttons, links and form controls. */
export const TAPPABLE =
  'button, a[href], input, select, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"]'

/**
 * A connection handle a press starts a wire from. At rest these are the
 * handles React Flow marks `connectionindicator` and lets take the pointer,
 * but it takes that class off the handle a wire is drawn from (in strict
 * mode, off every handle of its type) until the wire ends, so a hole cut
 * mid-wire would leave that handle under the target. These classes stay.
 */
export const CONNECTION_HANDLE = '.react-flow__handle.connectable.connectablestart'

/** What keeps its presses under a target: what a finger taps, and connection handles. */
const CONTROLS = `${TAPPABLE}, ${CONNECTION_HANDLE}`

export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

const round = (value: number) => Math.round(value * 10) / 10

/**
 * The clip-path of a target drawn over `target` on screen and laid out
 * `width` by `height` CSS pixels before its transforms, with a hole over each
 * of `controls` where it overlaps them; none when it overlaps none. The holes
 * are cut with the even-odd rule, so two controls that overlap each other
 * leave their shared part to the target.
 */
export function cutoutClipPath(target: ScreenRect, width: number, height: number, controls: ScreenRect[]): string {
  const scaleX = (target.right - target.left) / width
  const scaleY = (target.bottom - target.top) / height
  if (!(scaleX > 0 && scaleY > 0)) {
    return ''
  }
  const holes = controls.flatMap((control) => {
    const left = Math.max(control.left, target.left)
    const right = Math.min(control.right, target.right)
    const top = Math.max(control.top, target.top)
    const bottom = Math.min(control.bottom, target.bottom)
    if (right <= left || bottom <= top) {
      return []
    }
    const x = round((left - target.left) / scaleX)
    const y = round((top - target.top) / scaleY)
    const w = round((right - left) / scaleX)
    const h = round((bottom - top) / scaleY)
    return [`M${x} ${y}h${w}v${h}h${-w}Z`]
  })
  return holes.length > 0 ? `path(evenodd, "M0 0H${width}V${height}H0Z${holes.join('')}")` : ''
}

/** Whether two rects on screen share any area. */
export function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * The controls of `node` that keep their presses under a target: what a
 * finger taps and its connection handles. A control inside another (a button
 * in a `role="button"` row) is its outer control's.
 */
export function controlsOf(node: Element): Element[] {
  return Array.from(node.querySelectorAll(CONTROLS)).filter((control) => {
    const outer = control.parentElement?.closest(CONTROLS)
    return !(outer && node.contains(outer))
  })
}

/** Where the controls of `nodes` are drawn on screen. */
function controlRects(nodes: Iterable<Element>): ScreenRect[] {
  const rects: ScreenRect[] = []
  for (const node of nodes) {
    for (const control of controlsOf(node)) {
      const rect = control.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        rects.push(rect)
      }
    }
  }
  return rects
}

function cut(target: HTMLElement, rect: ScreenRect, under: Iterable<Element>): void {
  target.style.clipPath = cutoutClipPath(rect, target.offsetWidth, target.offsetHeight, controlRects(under))
}

/**
 * Cuts into each of `targets`, touch targets drawn in canvas `flow`, a hole
 * over every control of each node it lies over on screen, its own node and
 * its neighbours alike: whichever of them is drawn above the others (the
 * selected node, a later node, a frame's member), the controls under the
 * target keep their presses.
 */
export function cutOutOver(flow: Element, targets: Iterable<HTMLElement>): void {
  const nodes = Array.from(flow.querySelectorAll('.react-flow__node'), (node) => ({
    node,
    rect: node.getBoundingClientRect(),
  }))
  for (const target of targets) {
    const rect = target.getBoundingClientRect()
    cut(
      target,
      rect,
      nodes.filter((node) => overlaps(node.rect, rect)).map(({ node }) => node),
    )
  }
}

/**
 * Cuts into each of `targets`, drawn inside `node`, a hole over every control
 * of that node, and of no other. Cheaper than `cutOutOver`, which measures
 * every node on the canvas, for targets every node of a kind carries. A
 * neighbour's control under the part of a target that reaches outside the
 * node gets no hole.
 */
export function cutOutOverNode(node: Element, targets: Iterable<HTMLElement>): void {
  for (const target of targets) {
    cut(target, target.getBoundingClientRect(), [node])
  }
}

/**
 * Runs `cut`, which cuts the holes of targets drawn in canvas `flow` (with
 * `cutOutOver` or `cutOutOverNode`), now, and again on the next frame after an animation or
 * a transition ends or something scrolls in the canvas, as those move
 * controls without changing a node: a window's opening animation does, and so
 * does a finger scrolling a node's content. Returns what stops it: a layout
 * effect returns it, and runs this again when the nodes, the zoom or the
 * targets' size change. A control that appears or moves with none of these
 * (content loading into a node without changing its size) keeps the hole of
 * where it was until the next of them.
 */
export function keepCutOut(flow: Element, cut: () => void): () => void {
  let frame = 0
  const recut = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0
        cut()
      })
    }
  }
  cut()
  flow.addEventListener('animationend', recut)
  flow.addEventListener('transitionend', recut)
  // A scroll does not bubble, so it is caught on the way down.
  flow.addEventListener('scroll', recut, { capture: true, passive: true })
  return () => {
    cancelAnimationFrame(frame)
    flow.removeEventListener('animationend', recut)
    flow.removeEventListener('transitionend', recut)
    flow.removeEventListener('scroll', recut, { capture: true })
  }
}
