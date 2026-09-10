import type { SVGProps } from 'react'

import {
  BRAND_ACCENT,
  MARK_ACCENT_CELL,
  MARK_CELL_RADIUS,
  MARK_CELL_SIZE,
  MARK_CELLS,
  MARK_STROKE_WIDTH,
  MARK_VIEWBOX,
} from 'ui/components/ui/logo'

// The loading indicator. It IS the mark, animated -- not a spinner set beside a
// logo.
//
// THE GEOMETRY IS NOT REPEATED HERE. The cells, the accent and the drawing
// constants are read from the sibling mark, which owns them, so the two cannot
// be redrawn apart. The only thing this file adds is WHERE each square is at a
// given moment, which is a property of time rather than of the drawing.
//
// THE IDEA: a sliding puzzle that never retraces.
//
// A 2x2 grid holding four squares has no free cell, so there is no puzzle until
// one is made: the bottom-left square stands aside, and the hole it leaves is
// what the rest of the cycle moves through. Tiles then slide one at a time,
// EVERY ONE OF THEM CLOCKWISE, and the mark reassembles exactly.
//
// TWELVE SLIDES DO IT, and the reason is worth having because the obvious guess
// is wrong. A lap of the hole is four slides. It is tempting to say a lap
// therefore rotates every tile one cell, which would need four laps -- sixteen
// slides -- to bring the accent home. It does not: four slides shared between
// THREE tiles means one tile moves twice, so a lap is not a rotation, it is a
// THREE-CYCLE on the three occupied cells. A three-cycle has order three, so
// three laps -- twelve slides -- put every tile back in its own cell. Twelve is
// also the minimum: the hole only returns to its start on multiples of four,
// and the tiles only on multiples of three laps.
//
// THE RHYTHM IS A THREE-AGAINST-FOUR, and that is not decoration, it is the
// same fact from the other side. Three tiles take turns, so each moves on every
// THIRD beat. The hole crosses all four cells, so it laps on every FOURTH. The
// loop closes at twelve because that is where three and four resolve -- the
// cycle length and the hemiola are one property, not two.
//
// Each tile walks ONE COMPLETE CIRCUIT of the ring: right, down, left, up, back
// where it started. Only one is ever in motion, so the staging is absolute --
// there is never a question of where to look -- and the accent's own lap is the
// line the eye follows through the whole bar.
//
// THE ACCENT LEADS, and that is not a separate choice: the hole opens at
// bottom-left, and the only tile that can move clockwise into it is the one at
// bottom-right, which is the accent. Reverse the direction and the accent moves
// third instead. Worth knowing before changing either, because the two are the
// same decision.

// One beat to open the hole, twelve to shuffle, one to close it, two at rest.
const BEATS = 16
const BEAT_MS = 250
const CYCLE_MS = BEATS * BEAT_MS

// One beat as a percentage of the cycle. Every timing below is written in these
// units, so the meter cannot drift out of step with the duration.
const BEAT = 100 / BEATS

// The beat the hole closes on; the two after it are pure rest.
const CLOSE_BEAT = 13

// Fractions of a slide. The wind-up goes backwards before the tile sets off and
// the arrival goes past the cell before settling into it -- both under a tenth
// of a cell, felt rather than seen, and the whole difference between a tile
// that is pushed and one that is interpolated.
const WIND_UP = 0.08
const OVERSHOOT = 1.07

// `home` is the tile's own cell and `firstMove` is the beat it first slides on;
// it then slides on every third beat after that, four times in all.
//
// The first-moves are 3, 2 and 1 rather than 1, 2 and 3, and that ordering is
// forced rather than chosen: a tile can only move into the cell the hole is
// currently in, the hole opens at bottom-left, and going clockwise the tile that
// can reach it is the bottom-right one. So the accent goes first and the
// top-left square goes last.
const TILES = [
  { role: 'first', home: 0, firstMove: 3, accent: false },
  { role: 'second', home: 1, firstMove: 2, accent: false },
  { role: 'accent', home: MARK_ACCENT_CELL, firstMove: 1, accent: true },
]

// The square that stands aside to make the puzzle possible. It returns to the
// cell it left, because the twelve slides put every tile back in its own.
const HOLE = { role: 'hole', home: 3, accent: false }

// Array order is paint order, so the accent is drawn last and is never
// overlapped by a neighbour arriving.
const PAINT_ORDER = [TILES[0], TILES[1], HOLE, TILES[2]]

// Every keyframe lists translate then scale even though scale never changes for
// a tile: transforms interpolate smoothly only when both ends expose the same
// function list, and a keyframe that drops to a bare translate sends that
// segment through matrix interpolation instead.
const place = (dx: number, dy: number) => `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(1)`

// Where a tile stands after its nth slide. Walking the ring by increasing index
// is the whole rule; the modulo is what makes it a circuit rather than a path
// with an end.
const cellAfter = (tile: (typeof TILES)[number], step: number) => (tile.home + step + 1) % 4

const walkFor = (tile: (typeof TILES)[number]) => {
  const rows = [`  0%, ${(tile.firstMove * BEAT).toFixed(2)}% { transform: ${place(0, 0)}; }`]
  let from = tile.home
  for (let step = 0; step < 4; step++) {
    const beat = tile.firstMove + 3 * step
    const to = cellAfter(tile, step)
    // Offsets are measured from the tile's own cell, since that is where the
    // rect is actually drawn and a transform moves it from there.
    const baseX = MARK_CELLS[from].x - MARK_CELLS[tile.home].x
    const baseY = MARK_CELLS[from].y - MARK_CELLS[tile.home].y
    const stepX = MARK_CELLS[to].x - MARK_CELLS[from].x
    const stepY = MARK_CELLS[to].y - MARK_CELLS[from].y
    const start = beat * BEAT
    if (step > 0) {
      rows.push(`  ${start.toFixed(2)}% { transform: ${place(baseX, baseY)}; }`)
    }
    rows.push(`  ${(start + 1).toFixed(2)}% { transform: ${place(baseX - stepX * WIND_UP, baseY - stepY * WIND_UP)}; }`)
    rows.push(
      `  ${(start + 5).toFixed(2)}% { transform: ${place(baseX + stepX * OVERSHOOT, baseY + stepY * OVERSHOOT)}; }`,
    )
    // The last slide lands on the tile's own cell, so it holds there to the end
    // of the cycle and the loop closes on an identical frame rather than a
    // merely indistinguishable one.
    const tail = step === 3 ? ', 100%' : ''
    rows.push(`  ${((beat + 1) * BEAT).toFixed(2)}%${tail} { transform: ${place(baseX + stepX, baseY + stepY)}; }`)
    from = to
  }
  return `@keyframes oc-logo-loader-${tile.role} {\n${rows.join('\n')}\n}`
}

// The still version keeps the PROCESSION -- one square taking its turn, then
// the next, twelve times round -- and drops all the travel. A highlight steps
// from square to square on exactly the beats they would have slid on, so each
// tile still pulses every third beat against the hole's every fourth and the
// three-against-four is audible with nothing moving. Opacity only.
//
// Built by collecting stops and dropping any that land on the same percentage,
// so a beat at either edge of the loop needs no special case. Plain arrays
// rather than a Map or a Set on purpose: the live preview evaluates these files
// in a sandbox that exposes neither, and the failure is a component that will
// not render at all rather than a type error.
const stillFor = (role: string, beats: number[]) => {
  const stops = [
    { at: 0, opacity: 1 },
    { at: 100, opacity: 1 },
  ]
  for (const beat of beats) {
    stops.push({ at: beat * BEAT, opacity: 1 })
    stops.push({ at: beat * BEAT + 3, opacity: 0.35 })
    stops.push({ at: (beat + 1) * BEAT, opacity: 1 })
  }
  const body = stops
    .sort((a, b) => a.at - b.at)
    .filter((stop, index, all) => index === 0 || stop.at !== all[index - 1].at)
    .map((stop) => `  ${stop.at.toFixed(2)}% { opacity: ${stop.opacity}; }`)
    .join('\n')
  return `@keyframes oc-logo-loader-still-${role} {\n${body}\n}`
}

const beatsOf = (tile: (typeof TILES)[number]) => [
  tile.firstMove,
  tile.firstMove + 3,
  tile.firstMove + 6,
  tile.firstMove + 9,
]

// Written as animation LONGHANDS rather than the `animation` shorthand: the
// shorthand resets every property it does not mention, so a shorthand followed
// by per-square rules only works while the two stay in that order. Longhands
// have no order to get wrong.
//
// Scoped under an `oc-logo-loader` prefix so two instances on a page, or a host
// with keyframes of its own, cannot collide.
const CSS = `
.oc-logo-loader__cell {
  /* The hole's disappearance scales about its own centre, so fill-box.
     Translation is origin-independent, so the same box serves the tiles. */
  transform-box: fill-box;
  transform-origin: center;
  animation-duration: ${CYCLE_MS}ms;
  animation-timing-function: ease-in-out;
  animation-iteration-count: infinite;
}
${PAINT_ORDER.map((cell) => `.oc-logo-loader__cell--${cell.role} { animation-name: oc-logo-loader-${cell.role}; }`).join('\n')}

${TILES.map(walkFor).join('\n')}

/* The hole opens on the first beat and closes on the thirteenth, in the same
   cell both times -- twelve slides put every tile back in its own, so there is
   nowhere else for it to return to. It swells slightly before going, which is
   what stops the disappearance reading as a dropped frame. */
@keyframes oc-logo-loader-hole {
  0%, 1%      { transform: translate(0px, 0px) scale(1); }
  2.5%        { transform: translate(0px, 0px) scale(1.14); }
  5.5%        { transform: translate(0px, 0px) scale(0); }
  ${BEAT.toFixed(2)}%, ${(CLOSE_BEAT * BEAT).toFixed(2)}% { transform: translate(0px, 0px) scale(0); }
  ${(CLOSE_BEAT * BEAT + 4).toFixed(2)}%  { transform: translate(0px, 0px) scale(1.14); }
  ${((CLOSE_BEAT + 1) * BEAT).toFixed(2)}%, 100% { transform: translate(0px, 0px) scale(1); }
}

${TILES.map((tile) => stillFor(tile.role, beatsOf(tile))).join('\n')}
${stillFor('hole', [0, CLOSE_BEAT])}

@media (prefers-reduced-motion: reduce) {
  .oc-logo-loader__cell {
    transform: none;
  }
${PAINT_ORDER.map((cell) => `  .oc-logo-loader__cell--${cell.role} { animation-name: oc-logo-loader-still-${cell.role}; }`).join('\n')}
}
`

export interface LogoLoaderProps extends Omit<SVGProps<SVGSVGElement>, 'width' | 'height'> {
  /** Rendered edge length in px. A prop rather than a baked-in size because
   *  this is used small -- inline beside text, inside a node, in a button --
   *  far more often than it is used large. */
  size?: number
}

export function LogoLoader({ size = 24, className, ...props }: LogoLoaderProps) {
  return (
    // `role="img"` with a label, rather than a bare graphic: this is the whole
    // of the loading affordance, so unlabelled the state would be silent to a
    // screen reader. A host that already announces loading around it should
    // pass `aria-hidden` and let its own announcement stand.
    <svg
      xmlns='http://www.w3.org/2000/svg'
      viewBox={MARK_VIEWBOX}
      width={size}
      height={size}
      fill='none'
      role='img'
      aria-label='Loading'
      className={className}
      {...props}
    >
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {PAINT_ORDER.map((cell) => (
        <rect
          key={cell.role}
          className={`oc-logo-loader__cell oc-logo-loader__cell--${cell.role}`}
          x={MARK_CELLS[cell.home].x}
          y={MARK_CELLS[cell.home].y}
          width={MARK_CELL_SIZE}
          height={MARK_CELL_SIZE}
          rx={MARK_CELL_RADIUS}
          fill={cell.accent ? BRAND_ACCENT : 'none'}
          stroke={cell.accent ? undefined : 'currentColor'}
          strokeWidth={cell.accent ? undefined : MARK_STROKE_WIDTH}
        />
      ))}
    </svg>
  )
}
