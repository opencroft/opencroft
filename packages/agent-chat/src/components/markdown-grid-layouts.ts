/**
 * The row layouts a grid takes, and the only ones: each names the share of
 * the width every block spans, left to right. Grouped by how many blocks sit
 * side by side.
 */
export const MARKDOWN_GRID_LAYOUTS = [
  'full',
  '1/2+1/2',
  '1/3+2/3',
  '2/3+1/3',
  '1/4+3/4',
  '3/4+1/4',
  '1/3+1/3+1/3',
  '1/2+1/4+1/4',
  '1/4+1/2+1/4',
  '1/4+1/4+1/2',
  '1/4+1/4+1/4+1/4',
] as const

export type MarkdownGridLayout = (typeof MARKDOWN_GRID_LAYOUTS)[number]

const WIDE_SHARE: Record<string, number> = { full: 12, '3/4': 9, '2/3': 8, '1/2': 6, '1/3': 4, '1/4': 3 }

/** The share that is a half on both narrow and medium grids when two of them sit side by side. */
const QUARTER = WIDE_SHARE['1/4']
/** The share that stays a half on the medium grid when two of them sit side by side. */
const HALF = WIDE_SHARE['1/2']

export function isMarkdownGridLayout(value: unknown): value is MarkdownGridLayout {
  return (MARKDOWN_GRID_LAYOUTS as readonly unknown[]).includes(value)
}

/** Each block's share of the 12 wide columns, left to right. */
export function markdownGridShares(layout: MarkdownGridLayout): number[] {
  return layout.split('+').map((share) => WIDE_SHARE[share])
}

/** How many blocks sit side by side in a layout. */
export function markdownGridBlockCount(layout: MarkdownGridLayout): number {
  return layout.split('+').length
}

/** The layout giving `count` blocks equal shares -- full, halves, thirds, quarters -- if there is one. */
export function equalMarkdownGridLayout(count: number): MarkdownGridLayout | undefined {
  return MARKDOWN_GRID_LAYOUTS.find(
    (layout) => markdownGridBlockCount(layout) === count && new Set(markdownGridShares(layout)).size === 1,
  )
}

/**
 * The layout a grid of `count` blocks takes: the one it names when that has
 * `count` blocks, else the equal one -- for a grid an edit has left with more
 * or fewer blocks than its layout. Undefined past four blocks.
 */
export function fittingMarkdownGridLayout(layout: unknown, count: number): MarkdownGridLayout | undefined {
  return isMarkdownGridLayout(layout) && markdownGridBlockCount(layout) === count
    ? layout
    : equalMarkdownGridLayout(count)
}

/** A layout as a picker names it: `1/3 + 2/3`. */
export function markdownGridLayoutLabel(layout: MarkdownGridLayout): string {
  return layout === 'full' ? 'Full width' : layout.split('+').join(' + ')
}

/**
 * How many of the grid's 12 columns a block spans at each breakpoint: a half
 * or the whole row on the narrow and medium grids, its share on the wide one.
 */
export interface MarkdownGridPlacement {
  narrow: 6 | 12
  medium: 6 | 12
  wide: number
}

/**
 * Where each block sits. Wide, every layout fills one row. Below wide, two
 * quarters side by side become a row of halves, narrow too; the two halves of
 * 1/2 + 1/2 stay side by side on medium and stack on narrow; every other block
 * takes the whole row. Blocks keep their source order. So 1/2 + 1/4 + 1/4 is
 * a full row and then two halves, while thirds and 1/4 + 1/2 + 1/4 stack.
 */
export function markdownGridPlacements(layout: MarkdownGridLayout): MarkdownGridPlacement[] {
  const wide = markdownGridShares(layout)
  const placements: MarkdownGridPlacement[] = []
  for (let k = 0; k < wide.length; k++) {
    if (wide[k] === QUARTER && wide[k + 1] === QUARTER) {
      placements.push({ narrow: 6, medium: 6, wide: QUARTER }, { narrow: 6, medium: 6, wide: QUARTER })
      k++
    } else if (layout === '1/2+1/2') {
      placements.push({ narrow: 12, medium: 6, wide: HALF })
    } else {
      placements.push({ narrow: 12, medium: 12, wide: wide[k] })
    }
  }
  return placements
}
