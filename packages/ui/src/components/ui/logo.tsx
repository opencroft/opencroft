import type { SVGProps } from 'react'

// The OpenCroft mark -- the "Croft Plot": four rounded squares in a 2x2 grid,
// the bottom-right one filled.
//
// THE ACCENT IS STATED OUTRIGHT, and that is the decision this whole project
// exists to hold. A mark's second colour is part of the mark, not a surface
// treatment: reading it from whatever theme the mark is dropped into would
// repaint the logo differently in every product, and against a neutral palette
// it repaints it into near-invisibility. So the accent is a literal here and
// nothing about a host can move it.
//
// EVERYTHING ELSE INHERITS, which is the other half of the same decision. The
// outline is drawn in currentColor, so it takes the surrounding text colour and
// one file sits correctly on a light or a dark background without a second
// variant per theme.
//
// THIS FILE OWNS THE GEOMETRY for everything in this project that draws the
// mark. The animated version reads the cells and the accent from here rather
// than holding its own copy, so the mark cannot be redrawn in one place and not
// the other.

/** The brand accent. A literal by design -- see the note above. */
export const BRAND_ACCENT = '#3b82f6'

/**
 * The four cells, in ring order: top-left, top-right, bottom-right,
 * bottom-left. Walking the array forwards is clockwise, which is what the
 * animated mark needs and what makes the accent's position meaningful.
 */
export const MARK_CELLS = [
  { x: 4, y: 4 },
  { x: 13, y: 4 },
  { x: 13, y: 13 },
  { x: 4, y: 13 },
]

/** Index into MARK_CELLS of the one filled cell. */
export const MARK_ACCENT_CELL = 2

export const MARK_VIEWBOX = '0 0 24 24'
export const MARK_CELL_SIZE = 7
export const MARK_CELL_RADIUS = 1.8
export const MARK_STROKE_WIDTH = 1.5

export interface LogoProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Rendered edge length in px. It carries its own size because an SVG with
   *  none stretches to whatever box it lands in, which makes every caller
   *  responsible for a decision the mark can make itself. */
  size?: number
}

export function Logo({ size = 24, ...props }: LogoProps) {
  return (
    <svg
      xmlns='http://www.w3.org/2000/svg'
      viewBox={MARK_VIEWBOX}
      width={size}
      height={size}
      fill='none'
      {...props}
    >
      {MARK_CELLS.map((cell, index) => {
        const accent = index === MARK_ACCENT_CELL
        return (
          <rect
            key={`${cell.x}-${cell.y}`}
            x={cell.x}
            y={cell.y}
            width={MARK_CELL_SIZE}
            height={MARK_CELL_SIZE}
            rx={MARK_CELL_RADIUS}
            fill={accent ? BRAND_ACCENT : 'none'}
            stroke={accent ? undefined : 'currentColor'}
            strokeWidth={accent ? undefined : MARK_STROKE_WIDTH}
          />
        )
      })}
    </svg>
  )
}
