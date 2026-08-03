'use client'

import type { Node } from '@xyflow/react'
import { Copy, Trash2, Wrench } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { clampPosition } from '@/app/_authed/(dashboard)/_canvas/clamp-position'
import { useEscapeKey } from '@/app/_authed/(dashboard)/_canvas/use-escape-key'
import { type ResolvedNode, resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

interface NodeContextMenuProps {
  position: { x: number; y: number }
  node: Node
  resolvedNode?: ResolvedNode
  onCopy: () => void
  onDelete: () => void
  /** Mobile-only: opens the node inspector (desktop already shows it docked). */
  onDetails?: () => void
  onClose: () => void
}

const MENU_WIDTH = 200
const MENU_MAX_HEIGHT = 400

function menuContext(node: Node): { nodeId: string; typeId: string; data: Record<string, unknown> } {
  return { nodeId: node.id, typeId: node.type ?? '', data: (node.data ?? {}) as Record<string, unknown> }
}

export function NodeContextMenu({
  position,
  node,
  resolvedNode,
  onCopy,
  onDelete,
  onDetails,
  onClose,
}: NodeContextMenuProps) {
  const items = resolvedNode?.contextMenuItems ?? []
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const ref = useRef<HTMLDivElement>(null)
  const clamped = clampPosition(position.x, position.y, MENU_WIDTH, MENU_MAX_HEIGHT)

  useEscapeKey(onClose)

  useEffect(() => {
    function handlePointer(e: MouseEvent | TouchEvent) {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('touchend', handlePointer)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('touchend', handlePointer)
    }
  }, [onClose])

  const nodeId = node.id
  const typeId = node.type
  const data = node.data

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the node's identity/type/data actually change, not on every render's fresh `node`/`items` object reference
  useEffect(() => {
    let cancelled = false
    const ctx = menuContext(node)
    Promise.all(
      items.map(async (item) => {
        if (!item.isEnabled) {
          return [item.id, true] as const
        }
        try {
          return [item.id, await item.isEnabled(ctx)] as const
        } catch (err) {
          console.error(`[node-context-menu] "${item.id}" isEnabled failed:`, err)
          return [item.id, false] as const
        }
      }),
    ).then((entries) => {
      if (!cancelled) {
        setEnabled(Object.fromEntries(entries))
      }
    })
    return () => {
      cancelled = true
    }
  }, [resolvedNode, nodeId, typeId, data])

  const runExtensionItem = async (item: (typeof items)[number]) => {
    onClose()
    try {
      await item.onSelect(menuContext(node))
    } catch (err) {
      console.error(`[node-context-menu] "${item.id}" failed:`, err)
      toast.error(`"${item.label}" failed`, { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div
      ref={ref}
      className='fixed z-50 min-w-[180px] rounded-md border bg-popover py-1 shadow-lg'
      style={{ left: clamped.x, top: clamped.y }}
    >
      {onDetails && (
        <button
          type='button'
          className='flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent/50'
          onClick={() => {
            onClose()
            onDetails()
          }}
        >
          <Wrench className='size-4' />
          Details
        </button>
      )}
      <button
        type='button'
        className='flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent/50'
        onClick={() => {
          onClose()
          onCopy()
        }}
      >
        <Copy className='size-4' />
        Copy
      </button>
      <button
        type='button'
        className='flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-accent/50'
        onClick={() => {
          onClose()
          onDelete()
        }}
      >
        <Trash2 className='size-4' />
        Delete
      </button>
      {items.length > 0 && <div className='my-1 border-t' />}
      {items.map((item) => {
        const Icon = resolveIcon(item.icon)
        const itemEnabled = enabled[item.id] ?? true
        return (
          <button
            key={item.id}
            type='button'
            disabled={!itemEnabled}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-40 ${
              item.destructive ? 'text-destructive' : ''
            }`}
            onClick={() => runExtensionItem(item)}
          >
            <Icon className='size-4' />
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
