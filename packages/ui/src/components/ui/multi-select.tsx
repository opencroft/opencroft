import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { cn } from 'cn'

import { Button } from './button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './command'
import { Popover, PopoverContent, PopoverTrigger } from './popover'

export interface MultiSelectOption {
  value: string
  label: string
}

export interface MultiSelectProps {
  /** What can be chosen, in the order to list them. */
  options: MultiSelectOption[]
  /** The chosen values, in the order they were chosen. */
  value: string[]
  onValueChange: (value: string[]) => void
  /** The button's text with nothing chosen, such as "All agents". */
  placeholder: string
  /** The button's text with several chosen, such as "3 agents". One chosen reads as its own label. */
  summary: (count: number) => string
  /** What is being chosen, such as "Agents": the button is announced as this, then its text. */
  label: string
  searchPlaceholder?: string
  /** The list's line when the search matches nothing. */
  emptyText?: string
  disabled?: boolean
  /** On the button. Its width is fixed (`w-44` unless given) and never follows the choice. */
  className?: string
}

/**
 * Several values chosen behind one button. The button is one line at a fixed width, whatever is
 * chosen: its text truncates rather than wraps, so the row it sits in keeps its height. It opens a
 * list with a search field, a checkbox per option and Clear; the list stays open while values are
 * ticked, and Escape or a press outside closes it.
 *
 * A chosen value the options do not carry stays in the list, checked, after the options, so it can
 * still be unchecked; it is named by its raw value. A host that wants it named keeps it in
 * `options`.
 */
export function MultiSelect({
  options,
  value,
  onValueChange,
  placeholder,
  summary,
  label,
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing matches.',
  disabled,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const labels = new Map(options.map((option) => [option.value, option.label]))
  const labelOf = (v: string) => labels.get(v) ?? v
  const rows = [...options, ...value.filter((v) => !labels.has(v)).map((v) => ({ value: v, label: v }))]
  // The search reads labels only: a value can be an id the reader never sees.
  const needle = query.trim().toLowerCase()
  const shown = needle ? rows.filter((row) => row.label.toLowerCase().includes(needle)) : rows
  const chosen = new Set(value)
  const text = value.length === 0 ? placeholder : value.length === 1 ? labelOf(value[0]) : summary(value.length)

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type='button'
            variant='outline'
            size='sm'
            role='combobox'
            aria-expanded={open}
            aria-label={`${label}: ${text}`}
            className={cn('w-44 justify-between font-normal', className)}
          />
        }
      >
        <span className='min-w-0 truncate'>{text}</span>
        <ChevronsUpDown aria-hidden='true' className='opacity-50' />
      </PopoverTrigger>
      <PopoverContent align='start' className='w-72 max-w-(--available-width) gap-0 p-0'>
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchPlaceholder}
            aria-label={`Search ${label.toLowerCase()}`}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {shown.map((row) => {
                const checked = chosen.has(row.value)
                return (
                  <CommandItem
                    key={row.value}
                    value={row.value}
                    aria-checked={checked}
                    // The stock item's trailing check would say the same as the box, so it goes.
                    className='*:[svg:last-child]:hidden'
                    onSelect={() =>
                      onValueChange(checked ? value.filter((v) => v !== row.value) : [...value, row.value])
                    }
                  >
                    {/* Drawn, not a Checkbox: the row is the control, and a button inside an option
                        would be a second one. */}
                    <span
                      aria-hidden='true'
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input',
                        checked && 'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {checked ? <Check className='size-3.5' /> : null}
                    </span>
                    <span className='min-w-0 truncate'>{row.label}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
          <CommandSeparator />
          <div className='flex justify-end p-1'>
            <Button type='button' variant='ghost' size='sm' disabled={value.length === 0} onClick={() => onValueChange([])}>
              Clear
            </Button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
