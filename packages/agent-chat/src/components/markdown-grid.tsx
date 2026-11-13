import { cn } from 'cn'
import type { ReactNode } from 'react'

import {
  type MarkdownGridLayout,
  type MarkdownGridPlacement,
  markdownGridPlacements,
  markdownGridShares,
} from './markdown-grid-layouts'

/*
 * The layout grid: 12 columns at every width, with Tailwind's container
 * breakpoints measured on the grid's container, not the window:
 *
 *   narrow  under @xl (36rem)    16px gutters, quarters paired as halves
 *   medium  @xl to @3xl (48rem)  32px gutters, 1/2 + 1/2 side by side too
 *   wide    @3xl and up          32px gutters, the layout as chosen
 *
 * A documentation page's content (832px at its widest) is wide, and its
 * columns are 40px there. The outer margins are the surface's own -- the
 * page's or the bubble's padding -- so the grid's edges line up with the prose
 * above and below it.
 */
const GRID = 'grid grid-cols-12 gap-4 @xl:gap-8'

// Listed out in full rather than built from the number: a class name assembled
// at runtime is one no stylesheet scanner ever sees.
const NARROW_SPAN: Record<MarkdownGridPlacement['narrow'], string> = {
  6: 'col-span-6',
  12: 'col-span-12',
}
const MEDIUM_SPAN: Record<MarkdownGridPlacement['medium'], string> = {
  6: '@xl:col-span-6',
  12: '@xl:col-span-12',
}
// Index = columns spanned.
const WIDE_SPAN = [
  '',
  '@3xl:col-span-1',
  '@3xl:col-span-2',
  '@3xl:col-span-3',
  '@3xl:col-span-4',
  '@3xl:col-span-5',
  '@3xl:col-span-6',
  '@3xl:col-span-7',
  '@3xl:col-span-8',
  '@3xl:col-span-9',
  '@3xl:col-span-10',
  '@3xl:col-span-11',
  '@3xl:col-span-12',
]

/** A block's span classes, each breakpoint's only where its span changes. */
function spanClasses({ narrow, medium, wide }: MarkdownGridPlacement): string[] {
  return [NARROW_SPAN[narrow], medium !== narrow ? MEDIUM_SPAN[medium] : '', wide !== medium ? WIDE_SPAN[wide] : '']
}

/** A small drawing of a layout's row, for a picker. */
export function MarkdownGridLayoutPreview({ layout, className }: { layout: MarkdownGridLayout; className?: string }) {
  return (
    <span aria-hidden className={cn('flex h-3 w-10 shrink-0 gap-0.5', className)}>
      {markdownGridShares(layout).map((share, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional; nothing reorders them
        <span key={index} className='rounded-[2px] bg-current opacity-50' style={{ flexGrow: share }} />
      ))}
    </span>
  )
}

export interface MarkdownGridColumnProps {
  /** Where the block sits, from `markdownGridPlacements`. */
  placement: MarkdownGridPlacement
  children?: ReactNode
  /** Marks the block's edges with a dashed outline, which takes no room. For an editor. */
  outlined?: boolean
  className?: string
}

/**
 * One block of a grid, spanning its placement's columns at each breakpoint.
 * Its content sits flush with the block's edges: the gutter is
 * the spacing, not the first and last paragraph's margins.
 */
export function MarkdownGridColumn({ placement, children, outlined, className }: MarkdownGridColumnProps) {
  return (
    <div
      className={cn(
        ...spanClasses(placement),
        'min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        outlined && 'rounded-sm outline-1 outline-border outline-offset-4 outline-dashed',
        className,
      )}
    >
      {children}
    </div>
  )
}

export interface MarkdownGridProps {
  layout: MarkdownGridLayout
  /**
   * The blocks, left to right, which is also the order they stack in when
   * narrow: one for each share the layout names. Unused when `body` is given.
   */
  blocks?: ReactNode[]
  /**
   * The grid's items, in place of `blocks`, for a host that draws each block
   * itself -- an editor, whose blocks are its own editable nodes, each a
   * `MarkdownGridColumn`. Any element between the grid and those blocks has to
   * be `display: contents`, so the blocks stay the grid's items.
   */
  body?: ReactNode
  className?: string
}

/**
 * Blocks side by side in one of the grid's layouts, on a responsive layout
 * grid whose breakpoints follow the width of the content it sits in.
 */
export function MarkdownGrid({ layout, blocks = [], body, className }: MarkdownGridProps) {
  return (
    <div className={cn('@container my-2', className)}>
      <div className={GRID}>
        {body !== undefined
          ? body
          : markdownGridPlacements(layout).map((placement, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional; nothing reorders them
              <MarkdownGridColumn key={index} placement={placement}>
                {blocks[index]}
              </MarkdownGridColumn>
            ))}
      </div>
    </div>
  )
}
