'use client'

import { Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from 'ui/command'

import { clampPosition } from '@/app/_authed/(dashboard)/_canvas/clamp-position'
import { useEscapeKey } from '@/app/_authed/(dashboard)/_canvas/use-escape-key'
import type { ResolvedNode } from '@/app/_authed/(extension-runtime)/_client/registry'

interface FlowContextMenuProps {
  position: { x: number; y: number }
  extensions: ResolvedNode[]
  onSelect: (typeId: string) => void
  onNewExtension: () => void
  onClose: () => void
}

function groupByCategory(nodes: ResolvedNode[]): Map<string, ResolvedNode[]> {
  const map = new Map<string, ResolvedNode[]>()
  for (const node of nodes) {
    const key = node.category ?? 'Other'
    const list = map.get(key) ?? []
    list.push(node)
    map.set(key, list)
  }
  return map
}

export function FlowContextMenu({ position, extensions, onSelect, onNewExtension, onClose }: FlowContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const groups = groupByCategory(extensions)
  const clamped = clampPosition(position.x, position.y, 260, 360)

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [onClose])

  useEscapeKey(onClose)

  return (
    <div
      ref={ref}
      className='fixed z-50 w-[260px] rounded-md border bg-popover shadow-md'
      style={{ left: clamped.x, top: clamped.y }}
    >
      <Command>
        <CommandInput placeholder='Add node...' autoFocus />
        <CommandList>
          <CommandEmpty>No nodes found.</CommandEmpty>
          {Array.from(groups).map(([category, items]) => (
            <CommandGroup key={category} heading={category}>
              {items.map((node) => {
                const Icon = node.icon
                return (
                  <CommandItem
                    key={node.typeId}
                    value={`${category} ${node.name}`}
                    onSelect={() => onSelect(node.typeId)}
                  >
                    <Icon className='size-4' style={{ color: node.accent }} />
                    {node.name}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
          <CommandSeparator />
          <CommandGroup>
            <CommandItem onSelect={onNewExtension}>
              <Plus className='size-4' />
              New extension...
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
