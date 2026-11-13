'use client'

import type { Node } from '@xyflow/react'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  Boxes,
  ChevronRight,
  Copy,
  LayoutGrid,
  type LucideIcon,
  SquareArrowOutUpRight,
  Trash2,
  Ungroup,
  Workflow,
  Wrench,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
} from 'ui/dropdown-menu'
import { Field, FieldLabel } from 'ui/field'
import { Slider } from 'ui/slider'

import type { ArrangeAction } from '@/app/_authed/(dashboard)/_canvas/arrange-layout'
import { clampPosition } from '@/app/_authed/(dashboard)/_canvas/clamp-position'
import { useEscapeKey } from '@/app/_authed/(dashboard)/_canvas/use-escape-key'
import { useOutsideDismiss } from '@/app/_authed/(dashboard)/_canvas/use-outside-dismiss'
import {
  COLUMN_GAP_STEPS,
  columnGapSteps,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import type { NodeContextMenuContext } from '@/app/_authed/(extension-runtime)/_client/host'
import { type ResolvedNode, resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'
import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import type { ResolvedContext } from '@/app/_authed/(extension-runtime)/_types'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'

interface NodeContextMenuProps {
  position: { x: number; y: number }
  node: Node
  resolvedNode?: ResolvedNode
  /** The node's wired inputs as the canvas has them, keyed by target handle id. */
  contexts: Record<string, ResolvedContext>
  onCopy: () => void
  onDelete: () => void
  /**
   * Aligns, arranges or tidies up the selected nodes, a tidy-up with
   * `columnGapSteps` grid steps between its columns; `undefined` while fewer
   * than two are selected, and the menu has no Align then.
   */
  onArrange?: (action: ArrangeAction, columnGapSteps: number) => void
  /** Puts a new Section around the selected nodes; `undefined` while none is selected, and the menu has no Wrap in section then. */
  onWrapInSection?: () => void
  /** Moves the selected nodes into a new subgraph; `undefined` while none is selected, and the menu has no Make subgraph then. */
  onMakeSubgraph?: () => void
  /** Turns the subgraph into a Section in place; given only for a subgraph, and the menu has no Expand subgraph otherwise. */
  onExpandSubgraph?: () => void
  /** Opens the node as a canvas of its own; given only for a subgraph, and the menu has no Open otherwise. */
  onOpen?: () => void
  /** Mobile-only: opens the node inspector (desktop already shows it docked). */
  onDetails?: () => void
  onClose: () => void
}

// The kit's menu dress (DropdownMenuContent / DropdownMenuItem): a p-1 inset,
// rounded rows, a full-width separator.
const ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden hover:bg-muted disabled:pointer-events-none disabled:opacity-50'
const DESTRUCTIVE_CLASS = 'text-destructive hover:bg-destructive/10'

const MENU_WIDTH = 200
const MENU_MAX_HEIGHT = 400

// The tidy-up's column gap, as the person last set it, kept per browser.
const COLUMN_GAP_KEY = 'opencroft.canvas.tidyColumnGap'
const COLUMN_GAP_LABEL_ID = 'canvas-tidy-column-gap'

// The Align submenu, in groups split by a separator.
const ARRANGE_GROUPS: { action: ArrangeAction; label: string; icon: LucideIcon }[][] = [
  [
    { action: 'align-left', label: 'Align left edges', icon: AlignStartVertical },
    { action: 'align-centre-x', label: 'Align horizontal centres', icon: AlignCenterVertical },
    { action: 'align-right', label: 'Align right edges', icon: AlignEndVertical },
  ],
  [
    { action: 'align-top', label: 'Align top edges', icon: AlignStartHorizontal },
    { action: 'align-centre-y', label: 'Align vertical centres', icon: AlignCenterHorizontal },
    { action: 'align-bottom', label: 'Align bottom edges', icon: AlignEndHorizontal },
  ],
  [
    { action: 'row', label: 'Arrange in a row', icon: AlignHorizontalSpaceBetween },
    { action: 'column', label: 'Arrange in a column', icon: AlignVerticalSpaceBetween },
    { action: 'tidy', label: 'Tidy up', icon: Workflow },
  ],
]

/**
 * The Align row and its submenu. The submenu is the kit's, so it opens beside
 * the row on hover or a tap and turns to the other side where it would not fit.
 */
function ArrangeSubmenu({
  onArrange,
  onClose,
}: {
  onArrange: (action: ArrangeAction, columnGapSteps: number) => void
  onClose: () => void
}) {
  const [storedGap, setGap] = useLocalStorage<number>(COLUMN_GAP_KEY, COLUMN_GAP_STEPS.initial)
  const gap = columnGapSteps(storedGap)
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger openOnHover className={`${ITEM_CLASS} data-popup-open:bg-muted`}>
        <LayoutGrid className='size-4' />
        Align
        <ChevronRight className='ml-auto size-4' />
      </DropdownMenuTrigger>
      {/* Marked as a canvas menu: it is drawn outside the menu it opens from,
          and a press inside it must not dismiss that menu. */}
      <DropdownMenuSubContent data-canvas-menu>
        {ARRANGE_GROUPS.map((group, i) => (
          <Fragment key={group[0].action}>
            {i > 0 && <DropdownMenuSeparator />}
            {group.map(({ action, label, icon: Icon }) => (
              <DropdownMenuItem
                key={action}
                onClick={() => {
                  onClose()
                  onArrange(action, gap)
                }}
              >
                <Icon />
                {label}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
        {/* Under Tidy up, which it sets. */}
        <Field className='px-2 py-1.5'>
          <FieldLabel id={COLUMN_GAP_LABEL_ID} className='text-xs text-muted-foreground'>
            Tidy-up column gap: {gap} grid {gap === 1 ? 'step' : 'steps'}
          </FieldLabel>
          <Slider
            aria-labelledby={COLUMN_GAP_LABEL_ID}
            min={COLUMN_GAP_STEPS.min}
            max={COLUMN_GAP_STEPS.max}
            step={1}
            value={gap}
            onValueChange={(value) => setGap(columnGapSteps(Array.isArray(value) ? value[0] : value))}
          />
        </Field>
      </DropdownMenuSubContent>
    </DropdownMenu>
  )
}

// The items belong to the node's own extension, so they are told its bare type.
function menuContext(node: Node, contexts: Record<string, ResolvedContext>): NodeContextMenuContext {
  const type = parseType(node.type ?? '')?.bare ?? ''
  return { nodeId: node.id, type, typeId: type, data: (node.data ?? {}) as Record<string, unknown>, contexts }
}

export function NodeContextMenu({
  position,
  node,
  resolvedNode,
  contexts,
  onCopy,
  onDelete,
  onArrange,
  onWrapInSection,
  onMakeSubgraph,
  onExpandSubgraph,
  onOpen,
  onDetails,
  onClose,
}: NodeContextMenuProps) {
  const items = resolvedNode?.contextMenuItems ?? []
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const ref = useRef<HTMLDivElement>(null)
  const clamped = clampPosition(position.x, position.y, MENU_WIDTH, MENU_MAX_HEIGHT)

  useEscapeKey(onClose)
  useOutsideDismiss(ref, onClose)

  const nodeId = node.id
  const type = node.type
  const data = node.data

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run only when the node's identity/type/data actually change, not on every render's fresh `node`/`items`/`contexts` object reference; `contexts` is read when the menu mounts, and each open mounts a new menu
  useEffect(() => {
    let cancelled = false
    const ctx = menuContext(node, contexts)
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
  }, [resolvedNode, nodeId, type, data])

  const runExtensionItem = async (item: (typeof items)[number]) => {
    onClose()
    try {
      await item.onSelect(menuContext(node, contexts))
    } catch (err) {
      console.error(`[node-context-menu] "${item.id}" failed:`, err)
      toast.error(`"${item.label}" failed`, { description: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div
      ref={ref}
      data-canvas-menu
      className='fixed z-50 min-w-[180px] rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10'
      style={{ left: clamped.x, top: clamped.y }}
    >
      {onOpen && (
        <button
          type='button'
          className={ITEM_CLASS}
          onClick={() => {
            onClose()
            onOpen()
          }}
        >
          <SquareArrowOutUpRight className='size-4' />
          Open
        </button>
      )}
      {onDetails && (
        <button
          type='button'
          className={ITEM_CLASS}
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
        className={ITEM_CLASS}
        onClick={() => {
          onClose()
          onCopy()
        }}
      >
        <Copy className='size-4' />
        Copy
      </button>
      {onArrange && <ArrangeSubmenu onArrange={onArrange} onClose={onClose} />}
      {onWrapInSection && (
        <button
          type='button'
          className={ITEM_CLASS}
          onClick={() => {
            onClose()
            onWrapInSection()
          }}
        >
          <Boxes className='size-4' />
          Wrap in section
        </button>
      )}
      {onMakeSubgraph && (
        <button
          type='button'
          className={ITEM_CLASS}
          onClick={() => {
            onClose()
            onMakeSubgraph()
          }}
        >
          <Workflow className='size-4' />
          Make subgraph
        </button>
      )}
      {onExpandSubgraph && (
        <button
          type='button'
          className={ITEM_CLASS}
          onClick={() => {
            onClose()
            onExpandSubgraph()
          }}
        >
          <Ungroup className='size-4' />
          Expand subgraph
        </button>
      )}
      <button
        type='button'
        className={`${ITEM_CLASS} ${DESTRUCTIVE_CLASS}`}
        onClick={() => {
          onClose()
          onDelete()
        }}
      >
        <Trash2 className='size-4' />
        Delete
      </button>
      {items.length > 0 && <div className='-mx-1 my-1 h-px bg-border' />}
      {items.map((item) => {
        const Icon = resolveIcon(item.icon)
        const itemEnabled = enabled[item.id] ?? true
        return (
          <button
            key={item.id}
            type='button'
            disabled={!itemEnabled}
            className={item.destructive ? `${ITEM_CLASS} ${DESTRUCTIVE_CLASS}` : ITEM_CLASS}
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
