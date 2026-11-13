// The canvas grid: one step for where nodes are placed and how big they are,
// read by the canvas (moves, resizes, content-sized cards) and by the graph's
// write actions, so a node an agent sizes lands on the same lines as one a
// person drags. The canvas draws its background dots at this step.
//
// Safe for both server and client — no runtime imports.

/** The distance between two grid lines, in canvas pixels. */
export const GRID_STEP = 10

// Layout reports sizes such as 200.00000001; without the slack those would
// round up a whole step.
const CEIL_SLACK = 0.01

/** The nearest grid line: where a dragged position or edge lands. */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_STEP) * GRID_STEP
}

/** The nearest grid line at or before `value`: an edge that leaves nothing of what starts at `value` outside it. */
export function floorToGrid(value: number): number {
  return Math.floor((value + CEIL_SLACK) / GRID_STEP) * GRID_STEP
}

/** The smallest grid multiple that holds `value`: a size that never clips what it was given room for. */
export function ceilToGrid(value: number): number {
  return Math.ceil((value - CEIL_SLACK) / GRID_STEP) * GRID_STEP
}

export interface GridBox {
  x: number
  y: number
  width: number
  height: number
}

/** A size along either axis; an axis left out is not set. */
export interface AxisSize {
  width?: number
  height?: number
}

interface Sized {
  width?: number
  height?: number
  style?: object
}

/**
 * The size a node holds of its own, per axis, or nothing on an axis its
 * content sizes. The canvas's resizer writes the top-level `width`/`height`
 * and that wins over `style` where both are set, as it does when the canvas
 * draws the node.
 */
export function ownSize(node: Sized): AxisSize {
  const style = (node.style ?? {}) as { width?: unknown; height?: unknown }
  const width = node.width ?? style.width
  const height = node.height ?? style.height
  return {
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
  }
}

/**
 * The size a node is drawn at: as the canvas measured it, else the size it
 * holds of its own, else nothing (0) on an axis not yet measured.
 */
export function drawnSize(node: Sized & { measured?: { width?: number; height?: number } }): {
  width: number
  height: number
} {
  const own = ownSize(node)
  return {
    width: node.measured?.width ?? own.width ?? 0,
    height: node.measured?.height ?? own.height ?? 0,
  }
}

/**
 * `node` with `size` written on the axes it gives: always on `style`, and on
 * the top-level field too where the node has one, so the two never disagree.
 * Where the node carries a measured size, that axis of it is written as well:
 * `drawnSize` reads the measurement first, and a stale one would have whatever
 * reads the node next (the frame around it growing to hold it) see the size
 * it had before. The canvas measures the node again once it draws it.
 */
export function withSize<T extends Sized & { measured?: AxisSize }>(node: T, size: AxisSize): T {
  const next = {
    ...node,
    style: { ...node.style } as Record<string, unknown>,
    ...(node.measured ? { measured: { ...node.measured } } : {}),
  }
  for (const axis of ['width', 'height'] as const) {
    const value = size[axis]
    if (value === undefined) {
      continue
    }
    next.style[axis] = value
    if (node[axis] !== undefined) {
      next[axis] = value
    }
    if (next.measured) {
      next.measured[axis] = value
    }
  }
  return next
}

/** `node`'s own size rounded up to the grid on each axis it has one; a content-sized node is returned as is. */
export function withGridSize<T extends Sized>(node: T): T {
  const { width, height } = ownSize(node)
  if (width === undefined && height === undefined) {
    return node
  }
  return withSize(node, {
    ...(width === undefined ? {} : { width: ceilToGrid(width) }),
    ...(height === undefined ? {} : { height: ceilToGrid(height) }),
  })
}

/**
 * A box after a manual resize: both its top-left and its bottom-right corner
 * moved to the nearest grid line. The edge that was dragged lands on the line
 * nearest the pointer, and an edge that already sat on a line stays where it
 * is. A box narrower than one step keeps one step.
 */
export function snapResizedBox(box: GridBox): GridBox {
  const x = snapToGrid(box.x)
  const y = snapToGrid(box.y)
  return {
    x,
    y,
    width: Math.max(GRID_STEP, snapToGrid(box.x + box.width) - x),
    height: Math.max(GRID_STEP, snapToGrid(box.y + box.height) - y),
  }
}

interface Placed extends Sized {
  position: { x: number; y: number }
  measured?: { width?: number; height?: number }
}

/**
 * `node` once a resize of it ends: its box snapped by `snapResizedBox`. The
 * size is written on the axes the node holds one of its own (the resizer
 * sets the axes it drags); an axis its content sizes keeps doing so.
 */
export function snapResizedNode<T extends Placed>(node: T): T {
  const own = ownSize(node)
  const width = own.width ?? node.measured?.width
  const height = own.height ?? node.measured?.height
  if (width === undefined || height === undefined) {
    return node
  }
  const box = snapResizedBox({ ...node.position, width, height })
  return withSize(
    { ...node, position: { x: box.x, y: box.y } },
    {
      ...(own.width === undefined ? {} : { width: box.width }),
      ...(own.height === undefined ? {} : { height: box.height }),
    },
  )
}

/** `node` once a move of it ends: on the nearest grid point, its own size rounded up to the grid. */
export function snapMovedNode<T extends Placed>(node: T): T {
  return withGridSize({ ...node, position: { x: snapToGrid(node.position.x), y: snapToGrid(node.position.y) } })
}
