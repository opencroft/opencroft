'use client'

import { useState } from 'react'

import { cn } from 'cn'

/** Tailwind's palette: its hues in Tailwind's own order, the greys last. */
export const PALETTE_HUES = [
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
] as const

/** Every shade Tailwind draws each hue at, lightest first. */
export const PALETTE_SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const

export type PaletteHue = (typeof PALETTE_HUES)[number]
export type PaletteShade = (typeof PALETTE_SHADES)[number]

/** A palette colour's id -- `sky-300` -- as its hue and shade; anything else is not one. */
export function paletteColor(id: string | undefined): { hue: PaletteHue; shade: PaletteShade } | undefined {
  const match = /^([a-z]+)-(\d+)$/.exec(id ?? '')
  const hue = PALETTE_HUES.find((h) => h === match?.[1])
  const shade = PALETTE_SHADES.find((s) => s === match?.[2])
  return hue && shade ? { hue, shade } : undefined
}

/**
 * The text-colour class for a palette colour's id, or `undefined` for anything
 * that is not one. Built from the id, so no scanner sees these classes in the
 * source: the app's stylesheet has to generate every one of them.
 */
export function paletteTextClass(id: string | undefined): string | undefined {
  return paletteColor(id) ? `text-${id}` : undefined
}

/** A round colour swatch, drawn in the button's text colour. */
export const SWATCH =
  'size-5 rounded-full bg-current ring-offset-2 ring-offset-popover outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring'

function hueLabel(hue: PaletteHue): string {
  return hue.charAt(0).toUpperCase() + hue.slice(1)
}

export interface ColorPaletteProps {
  /** The chosen colour's id (`sky-300`); anything else chooses none of the palette. */
  color?: string
  /** A palette colour was chosen, by its id. */
  onColorChange: (color: string) => void
  className?: string
}

/**
 * Tailwind's palette as two rows: its hues, each drawn at 500, and the shades
 * of the hue in hand -- every hue at every shade, in two short rows rather
 * than a wall of 242 swatches. Choosing a hue takes its 500, or keeps the
 * shade already chosen in it.
 */
export function ColorPalette({ color, onColorChange, className }: ColorPaletteProps) {
  const chosen = paletteColor(color)
  const [picked, setPicked] = useState<PaletteHue | undefined>(chosen?.hue)
  const hue = picked ?? chosen?.hue
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div role='group' aria-label='Palette' className='grid grid-cols-11 justify-items-center gap-1'>
        {PALETTE_HUES.map((h) => (
          <button
            key={h}
            type='button'
            aria-pressed={h === hue}
            aria-label={hueLabel(h)}
            title={hueLabel(h)}
            onClick={() => {
              setPicked(h)
              onColorChange(`${h}-${chosen?.hue === h ? chosen.shade : '500'}`)
            }}
            className={cn(SWATCH, `text-${h}-500`, h === hue ? 'ring-2 ring-ring' : 'hover:scale-110')}
          />
        ))}
      </div>
      {hue ? (
        <div
          role='radiogroup'
          aria-label={`${hueLabel(hue)} shade`}
          className='grid grid-cols-11 justify-items-center gap-1'
        >
          {PALETTE_SHADES.map((shade) => {
            const id = `${hue}-${shade}`
            const checked = id === color
            return (
              <button
                key={id}
                type='button'
                role='radio'
                aria-checked={checked}
                aria-label={`${hueLabel(hue)} ${shade}`}
                title={`${hueLabel(hue)} ${shade}`}
                onClick={() => onColorChange(id)}
                className={cn(SWATCH, `text-${id}`, checked ? 'ring-2 ring-primary' : 'hover:scale-110')}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
