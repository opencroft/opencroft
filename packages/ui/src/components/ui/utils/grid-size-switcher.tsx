import { LayoutGrid } from 'lucide-react'
import { useState } from 'react'

import { Button } from 'ui/components/ui/button'
// `GridSize` is owned by the grid module and imported here, never re-declared
// and never re-exported: a grid size is a property of the grid, this is a
// control over it, and the exhaustive `gridSizeClasses` map lives beside the
// type. Re-exporting it would put two spellings of the same name in the
// package barrel again, which is the ambiguity this import removes.
import type { GridSize } from 'ui/components/ui/layout/grid'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'

export interface GridSizeSwitcherProps {
  value: GridSize
  onChange: (size: GridSize) => void
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon'
  align?: 'start' | 'center' | 'end'
}

const sizes: { value: GridSize; label: string }[] = [
  { value: 'large', label: 'Large' },
  { value: 'medium', label: 'Medium' },
  { value: 'small', label: 'Small' },
  { value: 'tiny', label: 'Tiny' },
]

export function GridSizeSwitcher({ value, onChange, buttonSize = 'default', align = 'end' }: GridSizeSwitcherProps) {
  const [open, setOpen] = useState(false)

  const handleSelect = (size: GridSize) => {
    onChange(size)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' size={buttonSize}>
          <LayoutGrid className='h-4 w-4' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className='w-40 p-2'>
        <div className='flex flex-col gap-1'>
          {sizes.map((size) => (
            <Button
              key={size.value}
              variant={value === size.value ? 'default' : 'ghost'}
              size='sm'
              onClick={() => handleSelect(size.value)}
              className='justify-start'
            >
              {size.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
