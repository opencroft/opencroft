// Section autolayout: an autolayout Section's members (its children, see
// `_frame-tree.ts`) tidied up from just inside its top-left corner, and the
// section fitted around them with the padding Wrap in section leaves. A node
// the section grows over stays outside it: only a drop makes a member.
//
// Pure, so the rule is testable without a canvas. It is idempotent: laid out
// again, a laid-out section changes nothing, so the canvas writes only when a
// node's size, a link or the section's members have changed.

import {
  type ArrangeLink,
  type ArrangeNode,
  type Box,
  type Point,
  type TidyOptions,
  tidy,
} from '@/app/_authed/(dashboard)/_canvas/arrange-layout'
import { WRAP_PADDING, WRAP_TITLE_PADDING } from '@/app/_authed/(dashboard)/_canvas/wrap-in-section'
import {
  columnGapSteps,
  isAutolayoutSection,
  type LaidOutNode,
  type SectionData,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { byIdOf, depthOf, growToHold } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { ceilToGrid, ownSize, snapToGrid, withSize } from '@/app/_authed/(extension-runtime)/_grid'

const COMMENT_TYPE = 'comment'

export interface AutolayoutNode extends ArrangeNode {
  type?: string
  data?: unknown
}

/**
 * The size `node` takes in a layout: the size it holds of its own, else the
 * one the canvas measured. Own size first, because a frame this pass has just
 * resized is not measured again yet. Null while an axis has neither.
 */
function layoutSize(node: AutolayoutNode): { width: number; height: number } | null {
  const own = ownSize(node)
  const width = own.width ?? node.measured?.width
  const height = own.height ?? node.measured?.height
  return width === undefined || height === undefined ? null : { width, height }
}

/**
 * Tidy up, run again on its own result until nothing moves. One run is not
 * always where a second leaves things: nodes sharing a cell of the table are
 * set side by side, and the next run reads them as columns of their own.
 * The runs are capped at one per box; the seeded test in
 * section-autolayout.test.ts checks that the result is settled.
 */
function settledTidy(boxes: readonly Box[], options: TidyOptions, corner: Point): Map<string, Point> {
  let placed = boxes
  let at = tidy(placed, options, corner.x, corner.y)
  for (let run = 0; run < boxes.length; run++) {
    const moved = placed.map((b) => ({ ...b, ...(at.get(b.id) as Point) }))
    if (moved.every((b, i) => b.x === placed[i].x && b.y === placed[i].y)) {
      break
    }
    placed = moved
    at = tidy(placed, options, corner.x, corner.y)
  }
  return at
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** What `laidOut` (a section's stored `laidOut`) holds for node `id`, if it holds a whole record. */
function recorded(laidOut: unknown, id: string): LaidOutNode | undefined {
  if (typeof laidOut !== 'object' || laidOut === null || !Object.hasOwn(laidOut, id)) {
    return undefined
  }
  const entry = (laidOut as Record<string, unknown>)[id]
  const read = field(entry, 'read')
  const at = field(entry, 'at')
  const [x, y, width, height, atX, atY] = [
    field(read, 'x'),
    field(read, 'y'),
    field(read, 'width'),
    field(read, 'height'),
    field(at, 'x'),
    field(at, 'y'),
  ].map(finite)
  if ([x, y, width, height, atX, atY].some((n) => n === undefined)) {
    return undefined
  }
  return {
    read: { x: x as number, y: y as number, width: width as number, height: height as number },
    at: { x: atX as number, y: atY as number },
  }
}

/** Whether `stored` holds exactly `laidOut`. */
function sameLaidOut(stored: unknown, laidOut: Record<string, LaidOutNode>): boolean {
  if (typeof stored !== 'object' || stored === null || Object.keys(stored).length !== Object.keys(laidOut).length) {
    return false
  }
  return Object.entries(laidOut).every(([id, { read, at }]) => {
    const held = recorded(stored, id)
    return (
      held !== undefined &&
      held.read.x === read.x &&
      held.read.y === read.y &&
      held.read.width === read.width &&
      held.read.height === read.height &&
      held.at.x === at.x &&
      held.at.y === at.y
    )
  })
}

/**
 * Where each box goes, and the record of the pass for each box. Boxes are
 * placed in the section's own coordinates, as its members are stored, so the
 * record still holds when the section is moved. While every box stands
 * where the last pass put it (`laidOut`, holding exactly these boxes), the
 * rows and columns are read from the boxes that pass read, and the boxes are
 * placed at their sizes now: a box that grew or shrank moves the others but
 * reorders none, and given its size back returns the layout to where it was.
 * Otherwise a box was moved, added or taken out, and the boxes are read where
 * they stand now, as Tidy up reads them.
 */
function placeBoxes(
  boxes: readonly Box[],
  laidOut: unknown,
  options: TidyOptions,
): { at: Map<string, Point>; record: Record<string, LaidOutNode> } {
  const corner = { x: WRAP_PADDING, y: WRAP_TITLE_PADDING }
  const records = boxes.map((b) => recorded(laidOut, b.id))
  const untouched =
    typeof laidOut === 'object' &&
    laidOut !== null &&
    Object.keys(laidOut).length === boxes.length &&
    records.every((r, i) => r !== undefined && r.at.x === boxes[i].x && r.at.y === boxes[i].y)
  let at: Map<string, Point>
  let reads: LaidOutNode['read'][]
  if (untouched) {
    reads = records.map((r) => (r as LaidOutNode).read)
    const readSizes = new Map(boxes.map((b, i) => [b.id, { width: reads[i].width, height: reads[i].height }]))
    const asRead = boxes.map((b, i) => ({ ...b, x: reads[i].x, y: reads[i].y }))
    at = tidy(asRead, { ...options, readSizes }, corner.x, corner.y)
  } else {
    at = settledTidy(boxes, options, corner)
    // The settled layout reads back as itself, so it is the read the next pass starts from.
    reads = boxes.map((b) => ({ ...(at.get(b.id) as Point), width: b.width, height: b.height }))
  }
  const record = Object.fromEntries(boxes.map((b, i) => [b.id, { read: reads[i], at: at.get(b.id) as Point }]))
  return { at, record }
}

/**
 * `nodes` with `section` laid out, or `nodes` itself when nothing moves or a
 * member has no size yet. A frame among the members is laid out as one box;
 * its own members move with it.
 */
function layOutSection<N extends AutolayoutNode>(nodes: N[], section: N, links: readonly ArrangeLink[]): N[] {
  // A comment is an overlay on the canvas, not a node of the graph.
  const members = nodes.filter((n) => n.parentId === section.id && n.type !== COMMENT_TYPE)
  const boxes: Box[] = []
  for (const node of members) {
    const size = layoutSize(node)
    if (!size) {
      return nodes
    }
    boxes.push({ id: node.id, ...node.position, ...size })
  }
  if (boxes.length === 0) {
    return nodes
  }

  const data = (section.data ?? {}) as Partial<SectionData>
  const origin = { x: snapToGrid(section.position.x), y: snapToGrid(section.position.y) }
  const { at, record: laidOut } = placeBoxes(boxes, data.laidOut, {
    links,
    columnGapSteps: columnGapSteps(data.columnGapSteps),
  })
  const right = Math.max(...boxes.map((b) => (at.get(b.id) as Point).x + ceilToGrid(b.width)))
  const bottom = Math.max(...boxes.map((b) => (at.get(b.id) as Point).y + ceilToGrid(b.height)))
  const fitted = { width: right + WRAP_PADDING, height: bottom + WRAP_PADDING }

  let changed = false
  const next = nodes.map((n) => {
    if (n.id === section.id) {
      const own = ownSize(n)
      if (
        n.position.x === origin.x &&
        n.position.y === origin.y &&
        own.width === fitted.width &&
        own.height === fitted.height &&
        sameLaidOut(data.laidOut, laidOut)
      ) {
        return n
      }
      changed = true
      return withSize({ ...n, position: origin, data: { ...data, laidOut } }, fitted)
    }
    const point = at.get(n.id)
    if (!point || (point.x === n.position.x && point.y === n.position.y)) {
      return n
    }
    changed = true
    return { ...n, position: point }
  })
  return changed ? next : nodes
}

/**
 * `nodes` with every autolayout section laid out, the innermost first, so an
 * outer section lays out an inner one at its fitted size. A fitted section
 * that reaches past its parent's edge grows the parent, up the chain (see
 * `growToHold`). Returns `nodes` itself when nothing changes.
 */
export function autolayoutSections<N extends AutolayoutNode>(nodes: N[], links: readonly ArrangeLink[]): N[] {
  const byId = byIdOf(nodes)
  const depth = new Map(nodes.map((n) => [n.id, depthOf(n.id, byId)]))
  const sections = nodes.filter(isAutolayoutSection).sort((p, q) => (depth.get(q.id) ?? 0) - (depth.get(p.id) ?? 0))
  let current = nodes
  for (const { id } of sections) {
    const section = current.find((n) => n.id === id) as N
    current = growToHold(layOutSection(current, section, links), [id], isAutolayoutSection)
  }
  return current
}
