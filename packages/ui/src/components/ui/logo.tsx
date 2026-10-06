import type { SVGProps } from 'react'

// The OpenCroft mark -- the "Croft Plot": four rounded squares in a 2x2 grid,
// the bottom-right one filled.
//
// THE ACCENT IS THE BRAND'S, NOT THE THEME'S, and that is the decision this
// whole project exists to hold. A mark's second colour is part of the mark, not
// a surface treatment: reading it from whatever theme the mark is dropped into
// would repaint the logo differently in every product, and against a neutral
// palette it repaints it into near-invisibility. So no theme token reaches it.
//
// ONE THING MAY MOVE IT: a host that deliberately marks itself, such as a
// staging instance that must not be mistaken for production. That host sets
// one variable of its own, `--brand-accent`, to one of BRAND_COLORS. Nothing
// sets it by accident, and a host that never sets it gets the default.
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

/** The colours a host may mark the brand with: the 500 shades of the
 *  Tailwind palette. Hex rather than a class, because the mark is also drawn
 *  where no stylesheet reaches it -- a standalone icon file. */
export const BRAND_COLORS = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  sky: '#0ea5e9',
  blue: '#3b82f6',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
}

export type BrandColor = keyof typeof BRAND_COLORS

export const DEFAULT_BRAND_COLOR: BrandColor = 'blue'

export function isBrandColor(value: unknown): value is BrandColor {
  return typeof value === 'string' && Object.hasOwn(BRAND_COLORS, value)
}

/** The variable a host sets to recolour the accent -- see the note above. */
export const BRAND_ACCENT_VAR = '--brand-accent'

/** The accent as every drawing of the mark paints it: the host's colour when
 *  it set one, the default when it did not. A CSS value, so it is applied
 *  through `style` -- an SVG presentation attribute is not guaranteed to
 *  resolve a variable. */
export const BRAND_ACCENT = `var(${BRAND_ACCENT_VAR}, ${BRAND_COLORS[DEFAULT_BRAND_COLOR]})`

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
  /** The brand colour to draw the accent in, for a drawing no page variable
   *  reaches: a standalone image, whose renderer may not resolve one set on
   *  an ancestor. Omitted, the accent follows the host's variable. */
  accent?: BrandColor
}

export function Logo({ size = 24, accent: accentColor, ...props }: LogoProps) {
  const accentFill = accentColor ? BRAND_COLORS[accentColor] : BRAND_ACCENT
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
            fill={accent ? undefined : 'none'}
            style={accent ? { fill: accentFill } : undefined}
            stroke={accent ? undefined : 'currentColor'}
            strokeWidth={accent ? undefined : MARK_STROKE_WIDTH}
          />
        )
      })}
    </svg>
  )
}
