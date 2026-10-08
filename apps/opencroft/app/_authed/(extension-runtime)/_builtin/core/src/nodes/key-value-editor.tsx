import { legacy } from '@opencroft/client'
import type { ChangeEvent } from 'react'

const { Button, Input, Label, icons } = legacy

// A name/value pair as stored in node data — request headers, environment
// variables, and anything else shaped like a small string map that has to keep
// its order and allow blank rows while being edited.
export interface KeyValue {
  name: string
  value: string
}

export function KeyValueEditor({
  label,
  entries,
  onChange,
  valuePlaceholder = 'value',
}: {
  label: string
  entries: KeyValue[]
  onChange: (entries: KeyValue[]) => void
  valuePlaceholder?: string
}) {
  const set = (index: number, patch: Partial<KeyValue>) => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  }

  return (
    <div className='flex flex-col gap-1.5'>
      <Label className='text-[10px] text-muted-foreground'>{label}</Label>
      {entries.map((entry, index) => (
        // Index-keyed deliberately: rows are positional and a name is free to
        // be blank or duplicated mid-edit, so there is no stable id to key on.
        <div key={index} className='flex items-center gap-1.5'>
          <Input
            value={entry.name}
            placeholder='name'
            className='h-7 w-1/3 text-xs font-mono'
            onChange={(e: ChangeEvent<HTMLInputElement>) => set(index, { name: e.target.value })}
          />
          <Input
            value={entry.value}
            placeholder={valuePlaceholder}
            className='h-7 text-xs font-mono'
            onChange={(e: ChangeEvent<HTMLInputElement>) => set(index, { value: e.target.value })}
          />
          <Button
            variant='ghost'
            size='sm'
            className='size-7 p-0'
            onClick={() => onChange(entries.filter((_, i) => i !== index))}
          >
            <icons.X className='size-3' />
          </Button>
        </div>
      ))}
      <Button
        variant='outline'
        size='sm'
        className='h-6 self-start text-[10px]'
        onClick={() => onChange([...entries, { name: '', value: '' }])}
      >
        <icons.Plus className='size-3 mr-1' />
        Add
      </Button>
    </div>
  )
}
