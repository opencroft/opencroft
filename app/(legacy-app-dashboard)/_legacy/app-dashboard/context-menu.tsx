'use client'

import { Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'

import type { NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'

interface FlowContextMenuProps {
  position: { x: number; y: number }
  definitions: readonly NodeTypeDefinition[]
  onSelect: (type: string) => void
  onNewCustomType: () => void
  onClose: () => void
}

function groupDefinitions(defs: readonly NodeTypeDefinition[]) {
  const groups = new Map<string, NodeTypeDefinition[]>()
  for (const def of defs) {
    const list = groups.get(def.group) || []
    list.push(def)
    groups.set(def.group, list)
  }
  return groups
}

function clampPosition(x: number, y: number, width: number, height: number) {
  const clamped = { x, y }
  if (x + width > window.innerWidth) {
    clamped.x = window.innerWidth - width - 8
  }
  if (y + height > window.innerHeight) {
    clamped.y = window.innerHeight - height - 8
  }
  return clamped
}

export function FlowContextMenu({ position, definitions, onSelect, onNewCustomType, onClose }: FlowContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const groups = groupDefinitions(definitions)
  const clamped = clampPosition(position.x, position.y, 240, 300)

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [onClose])

  return (
    <div ref={ref} className='fixed z-50 w-[240px] rounded-md border bg-popover shadow-md' style={{ left: clamped.x, top: clamped.y }}>
      <Command>
        <CommandInput placeholder='Add node...' autoFocus />
        <CommandList>
          <CommandEmpty>No nodes found.</CommandEmpty>
          {Array.from(groups).map(([group, defs]) => (
            <CommandGroup key={group} heading={group}>
              {defs.map((def) => {
                const Icon = def.icon
                return (
                  <CommandItem key={def.type} value={def.label} onSelect={() => onSelect(def.type)}>
                    <Icon className='h-4 w-4' />
                    {def.label}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup>
            <CommandItem onSelect={onNewCustomType}>
              <Plus className='h-4 w-4' />
              New custom type...
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
