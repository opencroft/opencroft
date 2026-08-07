'use client'

import { ClipboardPaste, Plus } from 'lucide-react'
import { useRef } from 'react'
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
import { useOutsideDismiss } from '@/app/_authed/(dashboard)/_canvas/use-outside-dismiss'
import type { ResolvedNode } from '@/app/_authed/(extension-runtime)/_client/registry'

interface FlowContextMenuProps {
  position: { x: number; y: number }
  extensions: ResolvedNode[]
  onSelect: (typeId: string) => void
  onNewExtension: () => void
  onClose: () => void
  onPaste: () => void
  /** Whether the clipboard holds anything pasteable right now. */
  canPaste: boolean
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

export function FlowContextMenu({
  position,
  extensions,
  onSelect,
  onNewExtension,
  onClose,
  onPaste,
  canPaste,
}: FlowContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const groups = groupByCategory(extensions)
  const clamped = clampPosition(position.x, position.y, 260, 360)

  useOutsideDismiss(ref, onClose)
  useEscapeKey(onClose)

  return (
    <div
      ref={ref}
      data-canvas-menu
      className='fixed z-50 w-[260px] rounded-md border bg-popover shadow-md'
      style={{ left: clamped.x, top: clamped.y }}
    >
      {/* Pinned above the searchable list, not inside it -- a cmdk CommandItem
          disappears while its own list is filtered by a search term, and
          Paste has to stay reachable regardless of what's typed. This is
          also the only way to reach a copied node on a phone: there's no
          Ctrl+V there. */}
      <button
        type='button'
        disabled={!canPaste}
        onClick={() => {
          onClose()
          onPaste()
        }}
        className='flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40'
      >
        <ClipboardPaste className='size-4' />
        Paste
      </button>
      <div className='my-1 border-t' />
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
