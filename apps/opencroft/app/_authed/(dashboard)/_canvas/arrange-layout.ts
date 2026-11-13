// Align and arrange: the selected nodes lined up on a shared edge or centre
// line, laid out one after another in a row or a column, or tidied up into
// columns along their links. Every place a node lands is on the grid, as a
// move or a paste leaves it.
//
// Pure, so the rule is testable without a canvas.

import { columnGapSteps } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { absolutePositions, byIdOf, placedRoots, toRelative } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { ceilToGrid, drawnSize, GRID_STEP, snapToGrid } from '@/app/_authed/(extension-runtime)/_grid'

export type ArrangeAction =
  | 'align-left'
  | 'align-centre-x'
  | 'align-right'
  | 'align-top'
  | 'align-centre-y'
  | 'align-bottom'
  | 'row'
  | 'column'
  | 'tidy'

export interface Point {
  x: number
  y: number
}

export interface ArrangeNode {
  id: string
  position: Point
  selected?: boolean
  parentId?: string
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  style?: object
}

/** A link drawn from one node to another, in its direction. */
export interface ArrangeLink {
  source: string
  target: string
}

export interface Size {
  width: number
  height: number
}

/** What a tidy-up lays the nodes out by: the links among them and the gap between columns, in grid steps. */
export interface TidyOptions {
  links: readonly ArrangeLink[]
  columnGapSteps: number
  /**
   * The size to read a box's row and column at, by box id, where it differs
   * from the size the box is laid out at. A box missing here is read at its
   * own size.
   */
  readSizes?: ReadonlyMap<string, Size>
}

/** A node as a layout reads it: its place on the canvas and its drawn size. */
export interface Box extends Point {
  id: string
  width: number
  height: number
}

type Axis = 'x' | 'y'

const ACROSS: Record<Axis, Axis> = { x: 'y', y: 'x' }
const LENGTH = { x: 'width', y: 'height' } as const

/** Ascending by `axis`, then by the other axis, then by id: one fixed order for boxes that tie. */
function byAxis(axis: Axis): (p: Box, q: Box) => number {
  return (p, q) => p[axis] - q[axis] || p[ACROSS[axis]] - q[ACROSS[axis]] || p.id.localeCompare(q.id)
}

/**
 * The boxes in bands along `axis`: boxes whose extents on `axis` overlap,
 * directly or through a box between them, share a band, and the bands come in
 * order along the axis. Along x a band is a column of boxes, along y a row.
 */
function bands(boxes: readonly Box[], axis: Axis): Box[][] {
  const out: Box[][] = []
  let end = Number.NEGATIVE_INFINITY
  for (const box of [...boxes].sort(byAxis(axis))) {
    if (box[axis] < end) {
      out[out.length - 1].push(box)
    } else {
      out.push([box])
    }
    end = Math.max(end, box[axis] + box[LENGTH[axis]])
  }
  return out
}

/**
 * Every box laid one after the next along `axis`, one grid step apart, in
 * the order they read in now: along the axis, and for boxes side by side
 * across it (a column laid out as a row) in their order across it.
 */
function lineUp(boxes: readonly Box[], axis: Axis, start: number): Map<string, number> {
  const ordered = bands(boxes, axis).flatMap((band) => band.sort(byAxis(ACROSS[axis])))
  const out = new Map<string, number>()
  let at = start
  for (const box of ordered) {
    out.set(box.id, at)
    at += ceilToGrid(box[LENGTH[axis]]) + GRID_STEP
  }
  return out
}

/**
 * Each linked box's column: the longest run of links leading into it, so a
 * box sits right of every box that links into it. A loop is cut where the
 * walk, taking boxes left to right, comes back to a box it is still inside:
 * the box further left keeps its place first.
 */
function linkRanks(boxes: readonly Box[], links: readonly ArrangeLink[]): Map<string, number> {
  const ordered = [...boxes].sort(byAxis('x'))
  const place = new Map(ordered.map((b, i) => [b.id, i]))
  const next = new Map<string, string[]>(ordered.map((b) => [b.id, []]))
  for (const link of links) {
    next.get(link.source)?.push(link.target)
  }
  const previous = new Map<string, string[]>(ordered.map((b) => [b.id, []]))
  const walking = new Set<string>()
  const walked = new Set<string>()
  const walk = (id: string) => {
    walking.add(id)
    for (const to of (next.get(id) ?? []).sort((p, q) => (place.get(p) ?? 0) - (place.get(q) ?? 0))) {
      if (walking.has(to)) {
        continue
      }
      previous.get(to)?.push(id)
      if (!walked.has(to)) {
        walk(to)
      }
    }
    walking.delete(id)
    walked.add(id)
  }
  for (const box of ordered) {
    if (!walked.has(box.id)) {
      walk(box.id)
    }
  }
  const ranks = new Map<string, number>()
  const rank = (id: string): number => {
    const known = ranks.get(id)
    if (known !== undefined) {
      return known
    }
    const value = Math.max(0, ...(previous.get(id) ?? []).map((from) => rank(from) + 1))
    ranks.set(id, value)
    return value
  }
  for (const box of ordered) {
    rank(box.id)
  }
  return ranks
}

/**
 * Linked boxes in one column per rank, `columnGap` apart, each column in the
 * boxes' current top-to-bottom order from `top`. Returns where each box goes
 * and the line one grid step below the lowest one.
 */
function linkedColumns(
  boxes: readonly Box[],
  links: readonly ArrangeLink[],
  columnGap: number,
  left: number,
  top: number,
): { at: Map<string, Point>; bottom: number } {
  const ranks = linkRanks(boxes, links)
  const columns: Box[][] = []
  for (const box of boxes) {
    const rank = ranks.get(box.id) ?? 0
    columns[rank] = [...(columns[rank] ?? []), box]
  }
  const at = new Map<string, Point>()
  let x = left
  let bottom = top
  for (const column of columns.filter(Boolean)) {
    let y = top
    for (const box of column.sort(byAxis('y'))) {
      at.set(box.id, { x, y })
      y += ceilToGrid(box.height) + GRID_STEP
    }
    bottom = Math.max(bottom, y)
    x += Math.max(...column.map((b) => ceilToGrid(b.width))) + columnGap
  }
  return { at, bottom }
}

/**
 * Boxes in a table of the rows and columns they stand in now, one grid step
 * between rows and between columns. Boxes that share a cell sit side by side
 * in it, one grid step apart; a row is as tall as its tallest box and a column
 * as wide as its widest cell. Rows and columns are read at `readSizes` where
 * it has a box, and the table is laid out at the boxes' own sizes.
 */
function table(
  boxes: readonly Box[],
  left: number,
  top: number,
  readSizes: ReadonlyMap<string, Size> = new Map(),
): Map<string, Point> {
  const own = new Map(boxes.map((b) => [b.id, b]))
  const read = boxes.map((b) => ({ ...b, ...readSizes.get(b.id) }))
  const rows = bands(read, 'y').map((row) => row.map((b) => own.get(b.id) as Box))
  const columnOf = new Map(bands(read, 'x').flatMap((band, i) => band.map((b) => [b.id, i] as const)))
  const cells = rows.map((row) => {
    const cellsOfRow: Box[][] = []
    for (const box of row.sort(byAxis('x'))) {
      const column = columnOf.get(box.id) ?? 0
      cellsOfRow[column] = [...(cellsOfRow[column] ?? []), box]
    }
    return cellsOfRow
  })
  const cellWidth = (cell: readonly Box[] = []) =>
    cell.reduce((sum, b) => sum + ceilToGrid(b.width), 0) + GRID_STEP * Math.max(0, cell.length - 1)
  const columnCount = Math.max(...cells.map((row) => row.length))
  const columnX: number[] = []
  let x = left
  for (let column = 0; column < columnCount; column++) {
    columnX.push(x)
    const width = Math.max(...cells.map((row) => cellWidth(row[column])))
    x += width > 0 ? width + GRID_STEP : 0
  }
  const at = new Map<string, Point>()
  let y = top
  rows.forEach((row, r) => {
    cells[r].forEach((cell, column) => {
      let cellX = columnX[column]
      for (const box of cell) {
        at.set(box.id, { x: cellX, y })
        cellX += ceilToGrid(box.width) + GRID_STEP
      }
    })
    y += Math.max(...row.map((b) => ceilToGrid(b.height))) + GRID_STEP
  })
  return at
}

/**
 * The tidy-up: boxes linked to another box among `boxes` in columns along
 * their links from the top-left corner (`left`, `top`), and the rest in a
 * table of their current rows and columns one grid step below them. Returns
 * where each box goes.
 */
export function tidy(boxes: readonly Box[], options: TidyOptions, left: number, top: number): Map<string, Point> {
  const ids = new Set(boxes.map((b) => b.id))
  const inner = options.links.filter((l) => l.source !== l.target && ids.has(l.source) && ids.has(l.target))
  const linkedIds = new Set(inner.flatMap((l) => [l.source, l.target]))
  const linked = boxes.filter((b) => linkedIds.has(b.id))
  const loose = boxes.filter((b) => !linkedIds.has(b.id))
  const columnGap = columnGapSteps(options.columnGapSteps) * GRID_STEP
  const columns = linkedColumns(linked, inner, columnGap, left, top)
  const rest =
    loose.length > 0 ? table(loose, left, linked.length > 0 ? columns.bottom : top, options.readSizes) : new Map()
  return new Map([...columns.at, ...rest])
}

/** Where each picked box goes, as its top-left corner on the canvas, on the grid. */
function targets(boxes: readonly Box[], action: ArrangeAction, options: TidyOptions): Map<string, Point> {
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.width))
  const maxY = Math.max(...boxes.map((b) => b.y + b.height))
  // The shared lines, each on the grid.
  const left = snapToGrid(minX)
  const top = snapToGrid(minY)
  const right = snapToGrid(maxX)
  const bottom = snapToGrid(maxY)
  const centreX = snapToGrid((minX + maxX) / 2)
  const centreY = snapToGrid((minY + maxY) / 2)
  const row = action === 'row' ? lineUp(boxes, 'x', left) : undefined
  const column = action === 'column' ? lineUp(boxes, 'y', top) : undefined
  const tidied = action === 'tidy' ? tidy(boxes, options, left, top) : undefined

  const place: Record<ArrangeAction, (b: Box) => Point> = {
    'align-left': (b) => ({ x: left, y: b.y }),
    'align-centre-x': (b) => ({ x: centreX - b.width / 2, y: b.y }),
    'align-right': (b) => ({ x: right - b.width, y: b.y }),
    'align-top': (b) => ({ x: b.x, y: top }),
    'align-centre-y': (b) => ({ x: b.x, y: centreY - b.height / 2 }),
    'align-bottom': (b) => ({ x: b.x, y: bottom - b.height }),
    // A row's top edge is the selection's, a column's left edge likewise.
    row: (b) => ({ x: row?.get(b.id) ?? b.x, y: top }),
    column: (b) => ({ x: left, y: column?.get(b.id) ?? b.y }),
    tidy: (b) => tidied?.get(b.id) ?? b,
  }
  return new Map(
    boxes.map((b) => {
      const { x, y } = place[action](b)
      return [b.id, { x: snapToGrid(x), y: snapToGrid(y) }]
    }),
  )
}

/**
 * The selected nodes aligned or arranged by `action`. Each node is placed by
 * its top-left corner on the grid, in canvas coordinates, and stored relative
 * to its frame. Align snaps the shared edge or centre line to the grid first;
 * a node whose size puts its corner between grid lines is rounded the way
 * `snapToGrid` rounds. In a row or a column neighbours are one grid step
 * apart, because the grid lets a node sit flush against the next and the two
 * would read as one block. A tidy-up lays the nodes out by `tidyOptions`. A
 * moved frame takes its members along, and a selected node inside a selected
 * frame moves with it. No node changes its frame, wherever the action puts
 * it: the frame grows to hold it (the caller's `growToHold`). Fewer than two
 * nodes to lay out leave everything where it is. A node that does not move
 * is returned as it was.
 */
export function arrangeSelected<N extends ArrangeNode>(
  nodes: readonly N[],
  action: ArrangeAction,
  tidyOptions: TidyOptions,
): N[] {
  const before = absolutePositions(nodes)
  const byId = byIdOf(nodes)
  const picked = placedRoots(nodes, new Set(nodes.filter((n) => n.selected).map((n) => n.id)))
  if (picked.length < 2) {
    return [...nodes]
  }
  const boxes = picked.map((n) => ({ id: n.id, ...(before.get(n.id) as Point), ...drawnSize(n) }))
  const moved = targets(boxes, action, tidyOptions)
  return nodes.map((n) => {
    const target = moved.get(n.id)
    if (!target) {
      return n
    }
    const position = toRelative(target, n.parentId ? byId.get(n.parentId) : undefined, before)
    return position.x === n.position.x && position.y === n.position.y ? n : { ...n, position }
  })
}
