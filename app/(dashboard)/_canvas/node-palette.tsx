'use client'

import { Pencil, Plus } from 'lucide-react'
import type { DragEvent } from 'react'

import type { ResolvedNode } from '@/app/(extension-runtime)/_client/registry'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/layout/scroll-area'

interface NodePaletteProps {
  extensions: ResolvedNode[]
  onAdd: (typeId: string) => void
  onNewExtension: () => void
  onEditExtension: (extensionId: string) => void
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

function handleDragStart(e: DragEvent<HTMLButtonElement>, typeId: string) {
  e.dataTransfer.setData('application/dashboard-extension', typeId)
  e.dataTransfer.effectAllowed = 'move'
}

export function NodePalette({ extensions, onAdd, onNewExtension, onEditExtension }: NodePaletteProps) {
  const groups = groupByCategory(extensions)

  return <></>

  return (
    <aside className='w-56 h-full border-r bg-card/50 flex flex-col'>
      <div className='px-3 py-2 border-b flex items-center gap-2'>
        <span className='flex-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground'>Nodes</span>
        <Button size='icon' variant='ghost' className='size-6' onClick={onNewExtension} title='New extension'>
          <Plus className='size-3.5' />
        </Button>
      </div>
      <ScrollArea className='flex-1 min-h-0'>
        {Array.from(groups.entries()).map(([category, items]) => (
          <div key={category}>
            <div className='px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground'>{category}</div>
            <div>
              {items.map((node) => {
                const Icon = node.icon
                const isLocal = node.extension.manifest.id.startsWith('local/')
                return (
                  <div key={node.typeId} className='group relative flex items-center hover:bg-accent/50'>
                    <button
                      title={node.description ?? node.name}
                      draggable
                      onDragStart={(e) => handleDragStart(e, node.typeId)}
                      onClick={() => onAdd(node.typeId)}
                      className='flex-1 flex items-center gap-2 px-3 py-1.5 text-xs text-left'
                    >
                      <Icon className='size-3.5 shrink-0' style={{ color: node.accent }} />
                      <span className='truncate'>{node.name}</span>
                    </button>
                    {isLocal && (
                      <Button size='icon' variant='ghost' className='size-5 mr-1 opacity-0 group-hover:opacity-100' title='Edit extension' onClick={() => onEditExtension(node.extension.manifest.id)}>
                        <Pencil className='size-3' />
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </ScrollArea>
    </aside>
  )
}
