// NodeContextMenu and FlowContextMenu render as floating siblings inside the
// same touch-handled canvas wrapper (they sit above the canvas, not inside a
// react-flow__node), so a tap that lands on one still bubbles up to the
// canvas's own long-press/tap gesture handlers. Every menu that floats above
// the canvas marks its root with `data-canvas-menu` so those handlers can
// recognise a touch that belongs to a menu and leave it alone -- otherwise a
// tap meant for a menu button gets reinterpreted as a tap on empty canvas,
// which clears the node selection before the button's own click can act on
// it.
export function isCanvasMenuTouchTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-canvas-menu]') !== null
}
