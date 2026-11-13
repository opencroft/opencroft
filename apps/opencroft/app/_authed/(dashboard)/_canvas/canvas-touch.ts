import { contentScrollsAt, NODE, ZOOM_PANE } from '@/app/_authed/(dashboard)/_canvas/canvas-node-scroll'

type TouchType = 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel'

/** A finger that landed on a node's content, and who has it. */
interface TrackedTouch {
  /** `pending` until its first move decides between the node and the canvas. */
  owner: 'pending' | 'node' | 'canvas'
  node: Element
  pane: Element
  start: Touch
}

/**
 * Decides who takes a touch gesture that starts on a node's content: the
 * content, or the canvas, which pans and zooms as it does over empty canvas.
 * The rule is the wheel's (`routeCanvasWheel`):
 * - a second finger makes a pinch, which zooms the canvas, selected node or not;
 * - one finger dragging is the content's only while the node is selected and
 *   an element of it under the finger can scroll on the drag's axis, or
 *   carries `SCROLLS_ITSELF`, or the finger landed on an element that takes
 *   every drag itself (`touch-action: none`); any other drag pans the canvas.
 *
 * One finger is decided at its first move, so a tap and a long press reach
 * the node and the canvas's own handlers untouched. A touch that
 * starts on a connection handle, a resize control, or the part of a draggable
 * node that drags it, is left to xyflow.
 *
 * It listens in the capture phase on an ancestor of the flow, so it decides
 * before the node's content sees the touch. The canvas cannot get such a
 * touch on its own: xyflow's pan and zoom skip any touch that starts inside a
 * `nopan` element, which window bodies and every node on a phone are. A
 * touch for the canvas is kept from the content (its moves cancelled, so
 * nothing scrolls natively; inside an unselected node, flow-editor.css also
 * sets `touch-action: none`, which holds where a move arrives uncancelable)
 * and a copy of each of its events is dispatched on
 * the zoom pane, where d3-zoom tracks the fingers by identifier. A finger the
 * canvas takes over at its first move is introduced to d3-zoom with the
 * position it started from, so the pan covers the whole drag.
 *
 * `onCanvasTakesTouch` runs whenever the canvas takes a finger that the
 * canvas's own touch handlers saw land, so they can drop a long press in
 * progress: they never see that finger's moves or release.
 */
export function routeCanvasTouch(canvas: HTMLElement, onCanvasTakesTouch: () => void): () => void {
  const tracked = new Map<number, TrackedTouch>()
  // The copies pass this listener on their way down to the pane.
  const copies = new WeakSet<Event>()

  // d3-zoom and xyflow read a touch event's type, target and touch lists, so a
  // plain event carrying the lists serves, with no TouchEvent constructor needed.
  const forward = (type: TouchType, event: TouchEvent, pane: Element, touches = Array.from(event.touches)) => {
    const copy = new Event(type, { bubbles: true, cancelable: true, composed: true })
    Object.defineProperties(copy, {
      touches: { value: touches },
      targetTouches: { value: touches },
      changedTouches: { value: Array.from(event.changedTouches) },
    })
    copies.add(copy)
    pane.dispatchEvent(copy)
  }

  const onTouchStart = (event: TouchEvent) => {
    if (copies.has(event)) {
      return
    }
    const active = new Set(Array.from(event.touches, (t) => t.identifier))
    for (const id of tracked.keys()) {
      if (!active.has(id)) {
        tracked.delete(id)
      }
    }
    const landed = routable(event.target)
    if (event.touches.length > 1) {
      // A pinch is the canvas's, with every finger it is made of.
      const pane = landed?.pane ?? tracked.values().next().value?.pane
      for (const t of tracked.values()) {
        t.owner = 'canvas'
      }
      if (landed) {
        for (const t of Array.from(event.changedTouches)) {
          tracked.set(t.identifier, { owner: 'canvas', ...landed, start: t })
        }
        event.stopPropagation()
      }
      if (pane && landed) {
        forward('touchstart', event, pane)
      }
      if (pane) {
        onCanvasTakesTouch()
      }
      return
    }
    if (landed) {
      const t = event.changedTouches[0]
      tracked.set(t.identifier, { owner: 'pending', ...landed, start: t })
    }
  }

  const onTouchMove = (event: TouchEvent) => {
    if (copies.has(event)) {
      return
    }
    let canvasMove: TrackedTouch | undefined
    for (const t of Array.from(event.changedTouches)) {
      const touch = tracked.get(t.identifier)
      if (!touch) {
        continue
      }
      if (touch.owner === 'pending') {
        touch.owner = ownerOfDrag(touch, t)
        if (touch.owner === 'canvas') {
          // d3-zoom meets the finger where it landed, and the move below takes it from there.
          const touches = Array.from(event.touches, (other) =>
            other.identifier === t.identifier ? touch.start : other,
          )
          forward('touchstart', event, touch.pane, touches)
          onCanvasTakesTouch()
        }
      }
      if (touch.owner === 'canvas') {
        canvasMove = touch
      }
    }
    if (canvasMove) {
      event.preventDefault()
      event.stopPropagation()
      forward('touchmove', event, canvasMove.pane)
    }
  }

  const onTouchEnd = (event: TouchEvent) => {
    if (copies.has(event)) {
      return
    }
    let canvasEnd: TrackedTouch | undefined
    for (const t of Array.from(event.changedTouches)) {
      const touch = tracked.get(t.identifier)
      if (touch?.owner === 'canvas') {
        canvasEnd = touch
      }
      tracked.delete(t.identifier)
    }
    if (canvasEnd) {
      event.stopPropagation()
      forward(event.type as TouchType, event, canvasEnd.pane)
    }
  }

  const options = { capture: true, passive: false }
  canvas.addEventListener('touchstart', onTouchStart, options)
  canvas.addEventListener('touchmove', onTouchMove, options)
  canvas.addEventListener('touchend', onTouchEnd, options)
  canvas.addEventListener('touchcancel', onTouchEnd, options)
  return () => {
    canvas.removeEventListener('touchstart', onTouchStart, options)
    canvas.removeEventListener('touchmove', onTouchMove, options)
    canvas.removeEventListener('touchend', onTouchEnd, options)
    canvas.removeEventListener('touchcancel', onTouchEnd, options)
  }
}

/** The node and zoom pane of a touch landing on node content the router decides for. */
function routable(target: EventTarget | null): { node: Element; pane: Element } | null {
  if (!(target instanceof Element)) {
    return null
  }
  const node = target.closest(NODE)
  const pane = node?.closest(ZOOM_PANE)
  if (!node || !pane || target.closest('.react-flow__handle, .react-flow__resize-control')) {
    return null
  }
  // xyflow drags a draggable node from anywhere outside its `nodrag` parts.
  const noDrag = target.closest('.nodrag')
  if (node.classList.contains('draggable') && !(noDrag && node.contains(noDrag))) {
    return null
  }
  return { node, pane }
}

/** Who takes a finger's drag, decided from its first move. */
function ownerOfDrag(touch: TrackedTouch, moved: Touch): 'node' | 'canvas' {
  if (!touch.node.classList.contains('selected')) {
    return 'canvas'
  }
  const vertical = Math.abs(moved.clientY - touch.start.clientY) >= Math.abs(moved.clientX - touch.start.clientX)
  const nodeTakes =
    contentDragsItself(touch.node, touch.start.target) ||
    contentScrollsAt(touch.node, touch.start.clientX, touch.start.clientY, vertical)
  return nodeTakes ? 'node' : 'canvas'
}

/**
 * Whether the finger landed on content of `node` that takes every drag
 * itself: `target` or one of its ancestors inside the node declares
 * `touch-action: none`, as a slider's handle or a scrollbar's thumb does.
 * Asked only of a selected node: flow-editor.css gives every element of an
 * unselected one `touch-action: none`.
 */
function contentDragsItself(node: Element, target: EventTarget): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== node; el = el.parentElement) {
    if (getComputedStyle(el).touchAction === 'none') {
      return true
    }
  }
  return false
}
