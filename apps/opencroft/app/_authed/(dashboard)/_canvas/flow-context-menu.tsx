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
  onSelect: (type: string) => void
  onNewExtension: () => void
  onClose: () => void
  onPaste: () => void
  /** Whether the clipboard holds anything pasteable right now. */
  canPaste: boolean
}

// The stock CommandItem appends a selection check, invisible but still taking
// room; nothing in this menu is ever checked.
const ITEM_CLASS = '*:[svg:last-child]:hidden'

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
      className='fixed z-50 w-[260px] overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10'
      style={{ left: clamped.x, top: clamped.y }}
    >
      {/* Pinned above the searchable list, not inside it -- a cmdk CommandItem
          disappears while its own list is filtered by a search term, and
          Paste has to stay reachable regardless of what's typed. This is
          also the only way to reach a copied node on a phone: there's no
          Ctrl+V there. */}
      <div className='p-1'>
        <button
          type='button'
          disabled={!canPaste}
          onClick={() => {
            onClose()
            onPaste()
          }}
          className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-muted disabled:pointer-events-none disabled:opacity-50'
        >
          <ClipboardPaste className='size-4' />
          Paste
        </button>
      </div>
      <div className='h-px bg-border' />
      {/* Flush with the menu: the Command's own p-1 would inset its list, and
          the list clips horizontally, so the separator below could never
          reach the edges. The groups' p-1 keeps the rows in line with Paste. */}
      <Command className='rounded-none! bg-transparent p-0'>
        <CommandInput placeholder='Add node...' autoFocus />
        <CommandList>
          <CommandEmpty>No nodes found.</CommandEmpty>
          {Array.from(groups).map(([category, items]) => (
            <CommandGroup key={category} heading={category}>
              {items.map((node) => {
                const Icon = node.icon
                return (
                  <CommandItem
                    key={node.type}
                    value={`${category} ${node.name}`}
                    onSelect={() => onSelect(node.type)}
                    className={ITEM_CLASS}
                  >
                    <Icon className='size-4' style={{ color: node.accent }} />
                    {node.name}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
          <CommandSeparator className='mx-0' />
          <CommandGroup>
            <CommandItem onSelect={onNewExtension} className={ITEM_CLASS}>
              <Plus className='size-4' />
              New extension...
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
