// Where a drag's pointer is: the point a canvas drag drops what it carries
// into a frame by (see `dropAtPoint` in `_frame-tree.ts`).

interface PointerLike {
  clientX?: unknown
  clientY?: unknown
  touches?: ArrayLike<{ clientX: number; clientY: number }>
  changedTouches?: ArrayLike<{ clientX: number; clientY: number }>
}

/**
 * Where `event` has the pointer or the finger on screen, or null when it
 * says nothing about it. React Flow hands a drag's handlers the browser's own
 * mouse or touch event; a touch that has just ended is no longer among
 * `touches`, only among `changedTouches`.
 */
export function clientPointOf(event: unknown): { x: number; y: number } | null {
  const e = (event ?? {}) as PointerLike
  if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
    return { x: e.clientX, y: e.clientY }
  }
  const touch = e.touches?.[0] ?? e.changedTouches?.[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}
