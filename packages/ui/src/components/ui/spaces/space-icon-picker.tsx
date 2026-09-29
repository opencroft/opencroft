import { PencilIcon, UploadIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '../button'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { cn } from 'cn'

import {
  findSpaceIconPreset,
  SPACE_ICON_COLORS,
  SPACE_ICON_GLYPHS,
  SpaceIcon,
  SpaceIconTile,
  spaceIconPresetValue,
} from './space-icon'

export interface SpaceIconPickerProps {
  /** The stored icon: `preset:<glyph>:<colour>` or an image URL. */
  value: string
  /** A new stored value, picked from the presets. */
  onChange: (value: string) => void
  /** The reader asked to upload an image. The file picker is the host's. */
  onUpload: () => void
  /** A save is in flight: the controls hold still until it lands. */
  pending?: boolean
  error?: string
  className?: string
}

export function SpaceIconPicker({ value, onChange, onUpload, pending, error, className }: SpaceIconPickerProps) {
  const [open, setOpen] = useState(false)
  const preset = findSpaceIconPreset(value)
  // The colour the glyph grid is drawn in. It follows the stored preset; while
  // an uploaded image is the icon, choosing a colour only repaints the grid.
  const [colorId, setColorId] = useState(preset?.color.id ?? SPACE_ICON_COLORS[0].id)
  const color = SPACE_ICON_COLORS.find((c) => c.id === colorId) ?? SPACE_ICON_COLORS[0]

  function chooseColor(id: string) {
    setColorId(id)
    if (preset) {
      onChange(spaceIconPresetValue(preset.glyph.id, id))
    }
  }

  function chooseGlyph(id: string) {
    onChange(spaceIconPresetValue(id, color.id))
    setOpen(false)
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className='flex items-center gap-4'>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label='Choose an icon'
            title='Choose an icon'
            disabled={pending}
            className='group relative shrink-0 rounded-[22%] ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
          >
            <SpaceIcon icon={value} className='size-16' />
            <span className='absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors group-hover:text-foreground'>
              <PencilIcon className='size-3' />
            </span>
          </PopoverTrigger>
          <PopoverContent align='start' className='w-[min(22rem,calc(100vw-2rem))] gap-3'>
            <div role='radiogroup' aria-label='Colour' className='flex justify-between'>
              {SPACE_ICON_COLORS.map((c) => {
                const checked = c.id === color.id
                return (
                  <button
                    key={c.id}
                    type='button'
                    role='radio'
                    aria-checked={checked}
                    aria-label={c.label}
                    title={c.label}
                    onClick={() => chooseColor(c.id)}
                    className={cn(
                      'size-5 rounded-full ring-offset-2 ring-offset-popover transition-transform outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      checked ? 'ring-2 ring-primary' : 'hover:scale-110',
                    )}
                    style={{ backgroundColor: c.value }}
                  />
                )
              })}
            </div>

            <div role='radiogroup' aria-label='Icon' className='grid grid-cols-6 gap-2'>
                {SPACE_ICON_GLYPHS.map((glyph) => {
                  const checked = glyph.id === preset?.glyph.id
                  return (
                    <button
                      key={glyph.id}
                      type='button'
                      role='radio'
                      aria-checked={checked}
                      aria-label={glyph.label}
                      title={glyph.label}
                      onClick={() => chooseGlyph(glyph.id)}
                      className={cn(
                        'rounded-[26%] ring-offset-2 ring-offset-popover outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        checked && 'ring-2 ring-primary',
                      )}
                    >
                      <SpaceIconTile glyph={glyph} color={color} className='aspect-square w-full' />
                    </button>
                  )
                })}
            </div>
          </PopoverContent>
        </Popover>

        <div className='flex flex-col items-start gap-1.5'>
          <Button type='button' variant='outline' size='sm' disabled={pending} onClick={onUpload}>
            <UploadIcon /> Upload image
          </Button>
          <p className='text-xs text-muted-foreground'>Or press the icon to pick a preset.</p>
        </div>
      </div>

      {error ? <p className='text-sm text-destructive'>{error}</p> : null}
    </div>
  )
}
