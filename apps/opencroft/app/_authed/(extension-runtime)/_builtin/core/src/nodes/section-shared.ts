// What a Section stores, shared by its inspector and by the canvas, which lays
// out an autolayout section's nodes. Also the column gap's range, which the
// canvas's Tidy up offers too.
//
// Pure: no runtime imports.

/** The node type of the core Section. */
export const SECTION_TYPE = 'builtin.core.section'

export interface SectionData {
  label: string
  color: string
  /** Keep the nodes the section holds tidied up, and the section fitted around them. */
  autolayout?: boolean
  /** The gap between linked columns in an autolayout, in grid steps (see `columnGapSteps`). */
  columnGapSteps?: number
  /** How the last autolayout pass read and placed each node, by node id (see `LaidOutNode`). */
  laidOut?: Record<string, LaidOutNode>
}

/**
 * Whether `node` is a Section with Autolayout on: it fits itself around its
 * members, so placing a node in it never grows it (see `growToHold`).
 */
export function isAutolayoutSection(node: { type?: string; data?: unknown }): boolean {
  return node.type === SECTION_TYPE && (node.data as Partial<SectionData> | undefined)?.autolayout === true
}

/**
 * One node of an autolayout section as the last pass left it. While every
 * node stands where the last pass put it, the next pass reads the rows and
 * columns from the `read` boxes, so a node that grows or shrinks moves the
 * others but never reorders them. A node moved, added or taken out makes the
 * pass read the nodes where they stand now, as Tidy up does.
 */
export interface LaidOutNode {
  /** Where the node stood and its size when the layout last read it. */
  read: { x: number; y: number; width: number; height: number }
  /** Where the last pass put it. */
  at: { x: number; y: number }
}

/**
 * The gap between two columns of linked nodes in a tidy-up, in grid steps.
 * It can be wider than the one grid step between neighbours elsewhere, so the
 * links drawn between the columns stay readable.
 */
export const COLUMN_GAP_STEPS = { min: 1, max: 10, initial: 2 } as const

/** `value` as a column gap in grid steps: a whole number within `COLUMN_GAP_STEPS`, else its initial value. */
export function columnGapSteps(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return COLUMN_GAP_STEPS.initial
  }
  return Math.min(COLUMN_GAP_STEPS.max, Math.max(COLUMN_GAP_STEPS.min, Math.round(value)))
}
