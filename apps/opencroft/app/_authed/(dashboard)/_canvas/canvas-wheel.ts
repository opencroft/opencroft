import { contentScrollsAt, NODE, ZOOM_PANE } from '@/app/_authed/(dashboard)/_canvas/canvas-node-scroll'

// The layer between the nodes and the zoom pane, there for the flow's whole life.
const VIEWPORT = '.react-flow__viewport'

/**
 * Decides who takes a mouse wheel over the canvas. Over a node, its content
 * takes the wheel only while the node is selected and an element of it under
 * the pointer can scroll: it overflows on the wheel's axis, or carries
 * `SCROLLS_ITSELF`. Any other wheel, and a touchpad pinch (a wheel with
 * ctrlKey) always, zooms the canvas as it does over empty canvas. A node that
 * keeps the wheel keeps it at the end of its content too, so an overshoot does
 * not zoom.
 *
 * It listens in the capture phase on an ancestor of the flow, so it decides
 * before the node's content sees the wheel. That is what lets it hand a wheel
 * to the canvas: a terminal scrolls its scrollback itself and stops the wheel's
 * propagation, and a `nowheel` class makes xyflow skip the wheel, so neither the
 * bubbling event nor xyflow's own filter reaches the zoom. Such a wheel is
 * cancelled and a copy of it is dispatched on the zoom pane itself, where d3-zoom
 * reads the same deltas, pointer position and ctrlKey from it.
 *
 * A wheel the node keeps is stopped on the flow's viewport as it bubbles, after
 * the content has handled it and before it reaches the zoom pane.
 */
export function routeCanvasWheel(canvas: HTMLElement): () => void {
  const keptByNode = new WeakSet<Event>()
  let guardedViewport: Element | null = null
  const stopKept = (event: Event) => {
    if (keptByNode.has(event)) {
      event.stopPropagation()
    }
  }
  const guard = (viewport: Element) => {
    if (viewport !== guardedViewport) {
      guardedViewport?.removeEventListener('wheel', stopKept)
      viewport.addEventListener('wheel', stopKept)
      guardedViewport = viewport
    }
  }

  const onWheel = (event: WheelEvent) => {
    const target = event.target
    if (!(target instanceof Element)) {
      return
    }
    const node = target.closest(NODE)
    if (!node) {
      return
    }
    const viewport = node.closest(VIEWPORT)
    const vertical = Math.abs(event.deltaX) <= Math.abs(event.deltaY)
    if (
      viewport &&
      !event.ctrlKey &&
      node.classList.contains('selected') &&
      contentScrollsAt(node, event.clientX, event.clientY, vertical)
    ) {
      keptByNode.add(event)
      guard(viewport)
      return
    }
    const pane = node.closest(ZOOM_PANE)
    if (!pane) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    pane.dispatchEvent(new WheelEvent('wheel', event))
  }

  canvas.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return () => {
    canvas.removeEventListener('wheel', onWheel, { capture: true })
    guardedViewport?.removeEventListener('wheel', stopKept)
    guardedViewport = null
  }
}
