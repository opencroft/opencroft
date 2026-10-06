'use client'

import { Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Input } from 'ui/components/ui/input'
import { ICON_NAMES, NamedIcon } from 'ui/components/ui/media/named-icon'
import { cn } from 'cn'

import { ColorPalette, paletteTextClass, SWATCH } from './color-palette'

/** How many matches the grid shows at once; a narrower search shows the rest. */
const SHOWN = 48

/** A colour the picker offers: drawn by `className`, which sets the text colour. */
export interface IconPickerColor {
  id: string
  label: string
  className: string
}

export interface IconPickerProps {
  /** The chosen icon's kebab-case name. */
  value?: string
  /** A new icon was chosen, by its kebab-case name. */
  onChange: (name: string) => void
  /** The colours to offer. Without them the picker offers no colour at all. */
  colors?: readonly IconPickerColor[]
  /**
   * Also offer Tailwind's whole palette, every hue at every shade, after
   * `colors`. A palette colour's id is its hue and shade, `sky-300`.
   */
  palette?: boolean
  /** The chosen colour's id; absent is the text's own colour. */
  color?: string
  /** A new colour was chosen, or `undefined` for the text's own. */
  onColorChange?: (color: string | undefined) => void
  /** Offers a Remove control when given. */
  onRemove?: () => void
  className?: string
}

/**
 * The names a search finds: those that start with it first, then those that
 * merely contain it. Before any search, every name, with the chosen one first:
 * the grid shows only its first screenful, and the chosen icon has to be on it
 * to be seen as chosen.
 */
function matching(query: string, chosen?: string): string[] {
  const words = query.trim().toLowerCase().replace(/\s+/g, '-')
  if (words === '') {
    return chosen && ICON_NAMES.includes(chosen)
      ? [chosen, ...ICON_NAMES.filter((name) => name !== chosen)]
      : [...ICON_NAMES]
  }
  const starts = ICON_NAMES.filter((name) => name.startsWith(words))
  const contains = ICON_NAMES.filter((name) => !name.startsWith(words) && name.includes(words))
  return [...starts, ...contains]
}

/**
 * Every Lucide icon, searchable by name, with an optional row of colours --
 * and Tailwind's palette under it -- and a Remove control: the body of a
 * popover that edits one icon. Each icon in the grid is fetched as it is
 * shown, so opening the picker loads only a screenful. Enter in the search
 * field picks the first match. Fully controlled.
 */
export function IconPicker({
  value,
  onChange,
  colors,
  palette,
  color,
  onColorChange,
  onRemove,
  className,
}: IconPickerProps) {
  const [query, setQuery] = useState('')
  // First is the icon the picker opened on, not whatever is chosen since: a
  // choice made in the grid stays where it was clicked.
  const [openedOn] = useState(value)
  const found = useMemo(() => matching(query, openedOn), [query, openedOn])
  const shown = found.slice(0, SHOWN)
  const colorClass = colors?.find((c) => c.id === color)?.className ?? (palette ? paletteTextClass(color) : undefined)

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && shown.length > 0) {
            event.preventDefault()
            onChange(shown[0])
          }
        }}
        placeholder='Search icons'
        aria-label='Search icons'
      />

      {(colors || palette) && onColorChange ? (
        <div role='radiogroup' aria-label='Colour' className='flex flex-wrap gap-2'>
          {[{ id: undefined, label: 'Text colour', className: 'text-foreground' }, ...(colors ?? [])].map((c) => {
            const checked = c.id === color
            return (
              <button
                key={c.id ?? 'text'}
                type='button'
                role='radio'
                aria-checked={checked}
                aria-label={c.label}
                title={c.label}
                onClick={() => onColorChange(c.id)}
                className={cn(SWATCH, c.className, checked ? 'ring-2 ring-primary' : 'hover:scale-110')}
              />
            )
          })}
        </div>
      ) : null}

      {palette && onColorChange ? <ColorPalette color={color} onColorChange={onColorChange} /> : null}

      {shown.length === 0 ? (
        <p className='py-6 text-center text-sm text-muted-foreground'>No icon is called that.</p>
      ) : (
        <div role='radiogroup' aria-label='Icon' className='grid grid-cols-8 gap-1'>
          {shown.map((name) => {
            const checked = name === value
            return (
              <button
                key={name}
                type='button'
                role='radio'
                aria-checked={checked}
                aria-label={name}
                title={name}
                onClick={() => onChange(name)}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                  checked && 'bg-accent ring-1 ring-primary',
                  colorClass,
                )}
              >
                <NamedIcon name={name} className='size-4' />
              </button>
            )
          })}
        </div>
      )}

      {found.length > shown.length ? (
        <p className='text-xs text-muted-foreground'>
          {shown.length} of {found.length} shown. Type more of the name to narrow it down.
        </p>
      ) : null}

      {onRemove ? (
        <Button type='button' variant='ghost' size='sm' className='self-start text-destructive' onClick={onRemove}>
          <Trash2 />
          Remove icon
        </Button>
      ) : null}
    </div>
  )
}
