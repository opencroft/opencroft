import type { LucideIcon } from 'lucide-react'
import { ChevronRight, Layers } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef } from 'react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/components/ui/collapsible'
import { ListEmpty } from '../utils/list-empty'
import { ListRow } from '../utils/list-row'
import { type RowDrag, type RowDragPoint, useRowDrag } from '../utils/row-drag'
import { ScrollArea } from '../layout/scroll-area'
import { cn } from 'cn'

export interface GraphOutlineItem {
  id: string
  label: string
  /** What kind of node it is, dimmed after the label. */
  typeName?: string
  icon: LucideIcon
  /** A CSS colour for the icon: the accent the node itself is drawn in. */
  accent?: string
  /**
   * A frame's members, in the order to list them (containers first, as on
   * the top level). Given, even empty, the row is a frame's: it expands and
   * collapses.
   */
  members?: GraphOutlineItem[]
  /**
   * A subgraph: a node that opens as a canvas of its own. Its row carries the
   * subgraph mark and expands onto `members` like a frame's, but it is never
   * dropped into, and no row is dragged from one level to another: a node
   * moves into or out of a subgraph by cut and paste.
   */
  subgraph?: boolean
}

/** Where a row was dropped. */
export interface GraphOutlineDrop {
  /**
   * The frame the node goes into; for the top-level zone, the subgraph the
   * node is in, or `null` for the top level.
   */
  parentId: string | null
  /**
   * The row it was dropped just before or after: a member of that frame, or a
   * top-level row. Left out for a drop onto a frame's own row or onto the
   * top-level zone, which say only where the node goes, not next to what.
   */
  beside?: { id: string; side: 'before' | 'after' }
}

export interface GraphOutlineProps {
  /**
   * The top level, in the order to list it. On every level the rows with
   * `members` are listed first, then the rest, each group in this order.
   */
  items: GraphOutlineItem[]
  /**
   * The selected node. Its row is marked active, and when it changes the
   * frames it lies in expand and its row scrolls into view.
   */
  selectedId?: string | null
  /** The frames shown collapsed; every other frame is expanded. */
  collapsed: ReadonlySet<string>
  onCollapsedChange: (collapsed: ReadonlySet<string>) => void
  /** Pressing a row. */
  onSelect?: (id: string) => void
  /**
   * A row dragged to a new place. Given, rows drag: by mouse, and by a long
   * press on touch. Never called for a drop into the node itself or a frame
   * inside it, nor for one that leaves it in the frame it is in with no row to
   * stand beside.
   */
  onMove?: (id: string, drop: GraphOutlineDrop) => void
  /**
   * A row's context menu asked for: a right-click, or on touch a long press
   * held on past the pickup. The menu is the host's, opened at `point`
   * (viewport coordinates) for the node.
   */
  onRowContextMenu?: (id: string, point: RowDragPoint) => void
  className?: string
}

// One step of indent per level, the width of the chevron column, so a member's
// chevron sits under its frame's icon.
const INDENT_PX = 20

// A frame row's top and bottom quarters put the node beside the frame; its
// middle puts it inside. A row that is not a frame's has halves only.
const FRAME_EDGE = 0.25

type Drag = { id: string }

type Over =
  | { kind: 'into'; frameId: string }
  | { kind: 'beside'; rowId: string; parentId: string | null; side: 'before' | 'after' }
  | { kind: 'top-level' }

interface TreeIndex {
  parentOf: Map<string, string | null>
  // Each node's id with the ids of everything beneath it.
  subtreeOf: Map<string, Set<string>>
  // The subgraph each node is in, the nearest above it; null for the top level.
  levelOf: Map<string, string | null>
  byId: Map<string, GraphOutlineItem>
}

function indexTree(items: GraphOutlineItem[]): TreeIndex {
  const parentOf = new Map<string, string | null>()
  const subtreeOf = new Map<string, Set<string>>()
  const levelOf = new Map<string, string | null>()
  const byId = new Map<string, GraphOutlineItem>()
  const walk = (rows: GraphOutlineItem[], parentId: string | null, levelId: string | null): string[] =>
    rows.flatMap((item) => {
      parentOf.set(item.id, parentId)
      levelOf.set(item.id, levelId)
      byId.set(item.id, item)
      const inner = item.members ? walk(item.members, item.id, item.subgraph ? item.id : levelId) : []
      const subtree = [item.id, ...inner]
      subtreeOf.set(item.id, new Set(subtree))
      return subtree
    })
  walk(items, null, null)
  return { parentOf, subtreeOf, levelOf, byId }
}

// The frames `id` lies in, outermost first; null when it is not in `items`.
function pathTo(items: GraphOutlineItem[], id: string): string[] | null {
  for (const item of items) {
    if (item.id === id) {
      return []
    }
    const inner = item.members ? pathTo(item.members, id) : null
    if (inner) {
      return [item.id, ...inner]
    }
  }
  return null
}

// What a drop onto `over` asks for, or null when it changes nothing. The
// top-level zone is the top of the dragged node's own level, `levelId`.
function dropOf(over: Over, currentParent: string | null, levelId: string | null): GraphOutlineDrop | null {
  if (over.kind === 'beside') {
    return { parentId: over.parentId, beside: { id: over.rowId, side: over.side } }
  }
  const parentId = over.kind === 'into' ? over.frameId : levelId
  return parentId === currentParent ? null : { parentId }
}

// A container: a frame or a subgraph, any row that expands onto members.
function isContainer(item: GraphOutlineItem | undefined): boolean {
  return item?.members !== undefined
}

// A canvas's nodes as a tree: a frame is a row that expands onto its members,
// indented beneath it, and every row is the kit's list row. On each level the
// containers come first, then the plain nodes, each group in the host's order.
//
// A row drops beside rows of its own kind only, a container's beside
// containers and a plain node's beside plain nodes: it is listed in its own
// group wherever it lands, so a line between the two groups would show a
// place the row never takes. Over a frame's row a plain node goes into the
// frame on the row's whole height; over a subgraph's row it offers no drop.
//
// Which frames are collapsed is the host's state, so it outlives this list
// being unmounted (a sidebar switching tabs) without the component storing
// anything. A new selection is the one thing that changes it from here: the
// frames the selected node lies in open, so the row it scrolls to exists.
//
// Rows drag with the kit's row drag, the chat list's gesture: by mouse, or by
// a long press on touch, where holding on past the pickup opens the row's menu
// instead. Dropped onto a frame's row the node goes into that frame, at any
// depth, and a frame row carries its whole subtree; dropped beside a row it
// goes into that row's frame, next to it; dropped on the top-level zone it
// leaves every frame. Never into itself or a frame inside it.
//
// A subgraph's row expands like a frame's, and its members are another level:
// a row drops only beside or into rows on its own level, and the top-level
// zone of a node inside a subgraph is that subgraph's top. A subgraph row is
// never dropped into.
export function GraphOutline({
  items,
  selectedId,
  collapsed,
  onCollapsedChange,
  onSelect,
  onMove,
  onRowContextMenu,
  className,
}: GraphOutlineProps) {
  const scrolledTo = useRef<string | null>(null)
  const latest = useRef({ items, collapsed, onCollapsedChange })
  latest.current = { items, collapsed, onCollapsedChange }
  const tree = useMemo(() => indexTree(items), [items])

  const rowDrag = useRowDrag<Drag, Over>({
    targetAt: (d, el, point) => {
      if (el?.closest('[data-outline-top-level]')) {
        return { kind: 'top-level' }
      }
      const row = el?.closest<HTMLElement>('[data-outline-row]')
      const id = row?.dataset.outlineRow
      if (!row || !id || tree.subtreeOf.get(d.id)?.has(id) || tree.levelOf.get(id) !== tree.levelOf.get(d.id)) {
        return null
      }
      const r = row.getBoundingClientRect()
      const at = r.height > 0 ? (point.y - r.top) / r.height : 0.5
      const isFrame = row.dataset.outlineFrame !== undefined
      if (isContainer(tree.byId.get(id)) !== isContainer(tree.byId.get(d.id))) {
        return isFrame ? { kind: 'into', frameId: id } : null
      }
      const edge = isFrame ? FRAME_EDGE : 0.5
      if (isFrame && at >= edge && at <= 1 - edge) {
        return { kind: 'into', frameId: id }
      }
      return { kind: 'beside', rowId: id, parentId: tree.parentOf.get(id) ?? null, side: at < edge ? 'before' : 'after' }
    },
    onDrop: (d, o) => {
      const drop = dropOf(o, tree.parentOf.get(d.id) ?? null, tree.levelOf.get(d.id) ?? null)
      if (drop) {
        onMove?.(d.id, drop)
      }
    },
  })

  // Keyed on the selection alone: opening the way to a row answers a node
  // being selected. Keyed on `collapsed` too, it would reopen a frame the
  // moment someone collapsed it over the selected row.
  useEffect(() => {
    if (!selectedId) {
      return
    }
    const { items, collapsed, onCollapsedChange } = latest.current
    const closed = (pathTo(items, selectedId) ?? []).filter((id) => collapsed.has(id))
    if (closed.length > 0) {
      onCollapsedChange(new Set([...collapsed].filter((id) => !closed.includes(id))))
    }
  }, [selectedId])

  // Once per selection, on the first render that has its row: the frames it
  // lies in may open a render after the selection arrives.
  useEffect(() => {
    if (!selectedId) {
      scrolledTo.current = null
      return
    }
    if (scrolledTo.current === selectedId) {
      return
    }
    const row = rowDrag.rootRef.current?.querySelector(`[data-outline-id="${CSS.escape(selectedId)}"]`)
    if (row) {
      row.scrollIntoView({ block: 'nearest' })
      scrolledTo.current = selectedId
    }
  })

  if (items.length === 0) {
    return (
      <div className={cn('flex h-full items-center justify-center p-4', className)}>
        <ListEmpty text='No nodes on the graph.' size='xs' />
      </div>
    )
  }

  const toggle = (id: string, open: boolean) => {
    const next = new Set(collapsed)
    if (open) {
      next.delete(id)
    } else {
      next.add(id)
    }
    onCollapsedChange(next)
  }

  const draggedId = (rowDrag.drag ?? rowDrag.ghost?.drag)?.id ?? null
  const draggedLevel = draggedId === null ? null : (tree.levelOf.get(draggedId) ?? null)
  const ghostItem = rowDrag.ghost ? tree.byId.get(rowDrag.ghost.drag.id) : undefined
  const GhostIcon = ghostItem?.icon

  return (
    <ScrollArea className={cn('h-full', className)}>
      <div ref={rowDrag.rootRef} className='relative p-1' {...rowDrag.rootProps}>
        <OutlineRows
          items={items}
          depth={0}
          selectedId={selectedId}
          collapsed={collapsed}
          onToggle={toggle}
          onSelect={onSelect}
          onRowContextMenu={onRowContextMenu}
          rowDrag={onMove ? rowDrag : null}
          draggedId={draggedId}
        />
        {/* While a member is dragged: the way out of every frame on its level,
            which no row offers when every row there is a frame's middle. */}
        {draggedId !== null && (tree.parentOf.get(draggedId) ?? null) !== draggedLevel ? (
          <div
            data-outline-top-level
            className={cn(
              'mt-1 flex items-center justify-center rounded-md border border-dashed py-1.5 text-xs',
              rowDrag.over?.kind === 'top-level' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
            )}
          >
            {draggedLevel === null ? 'Move to top level' : `Move to top of ${tree.byId.get(draggedLevel)?.label}`}
          </div>
        ) : null}
        {/* The row under a finger during a touch drag, translucent so the
            insert line it is aimed at shows through. Placed against the list's
            own box rather than the viewport, so a transformed ancestor cannot
            offset it. */}
        {rowDrag.ghost && ghostItem && GhostIcon ? (
          <div
            className='pointer-events-none absolute z-50 opacity-60'
            style={{ left: rowDrag.ghost.x, top: rowDrag.ghost.y, transform: 'translateY(-50%)' }}
          >
            <div className='flex w-56 items-center gap-2 rounded-md bg-background px-2 py-1 text-xs font-medium shadow-lg ring-1 ring-border'>
              <GhostIcon className='size-3.5 shrink-0' style={{ color: ghostItem.accent }} />
              <span className='truncate'>{ghostItem.label}</span>
            </div>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  )
}

interface RowsProps {
  items: GraphOutlineItem[]
  depth: number
  selectedId?: string | null
  collapsed: ReadonlySet<string>
  onToggle: (id: string, open: boolean) => void
  onSelect?: (id: string) => void
  onRowContextMenu?: (id: string, point: RowDragPoint) => void
  // The drag, when rows drag at all.
  rowDrag: RowDrag<Drag, Over> | null
  draggedId: string | null
}

function OutlineRows({ items, ...rest }: RowsProps) {
  const rows = [...items.filter(isContainer), ...items.filter((item) => !isContainer(item))]
  return (
    <ul className='flex flex-col gap-0.5'>
      {rows.map((item) => (
        <OutlineRow key={item.id} item={item} {...rest} />
      ))}
    </ul>
  )
}

function OutlineRow({
  item,
  depth,
  selectedId,
  collapsed,
  onToggle,
  onSelect,
  onRowContextMenu,
  rowDrag,
  draggedId,
}: Omit<RowsProps, 'items'> & { item: GraphOutlineItem }) {
  const Icon = item.icon
  const open = !collapsed.has(item.id)
  const expands = item.members !== undefined
  // A frame's row takes a drop into it; a subgraph's, which expands too, does not.
  const isFrame = expands && !item.subgraph
  const over = rowDrag?.over
  const into = over?.kind === 'into' && over.frameId === item.id
  const insert = over?.kind === 'beside' && over.rowId === item.id ? over.side : null
  const row = (
    <ListRow
      data-outline-id={item.id}
      title={item.label}
      leading={<Icon className='size-3.5 shrink-0' style={{ color: item.accent }} />}
      trailing={
        item.subgraph || item.typeName ? (
          <span className='flex min-w-0 items-center gap-1 text-muted-foreground'>
            {item.subgraph ? (
              <Layers role='img' aria-label='Subgraph' data-outline-subgraph='' className='size-3 shrink-0' />
            ) : null}
            {item.typeName ? <span className='max-w-24 truncate text-xs'>{item.typeName}</span> : null}
          </span>
        ) : undefined
      }
      active={item.id === selectedId}
      onSelect={onSelect ? () => onSelect(item.id) : undefined}
      onContextMenu={
        onRowContextMenu
          ? (event) => {
              event.preventDefault()
              onRowContextMenu(item.id, { x: event.clientX, y: event.clientY })
            }
          : undefined
      }
      className='flex-1'
    />
  )

  // The line a row is drawn on: the drag source and drop target, indented to
  // its depth, with the insert line drawn at that indent.
  const line = (leading: ReactNode) => (
    <div
      data-outline-row={item.id}
      data-outline-frame={isFrame ? '' : undefined}
      {...rowDrag?.sourceProps({ id: item.id }, { text: item.label })}
      className={cn(
        'relative flex min-w-0 items-center rounded-md',
        draggedId === item.id && 'opacity-40',
        rowDrag?.lifted?.id === item.id && 'bg-muted ring-2 ring-primary',
        into && 'bg-primary/10 ring-2 ring-primary',
      )}
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      {insert ? (
        <div
          className={cn('absolute right-1 z-10 h-0.5 rounded-full bg-primary', insert === 'before' ? '-top-0.5' : '-bottom-0.5')}
          style={{ left: depth * INDENT_PX + 4 }}
        />
      ) : null}
      {leading}
      {row}
    </div>
  )

  if (!expands) {
    return <li>{line(<span className='size-5 shrink-0' />)}</li>
  }

  return (
    <li>
      <Collapsible open={open} onOpenChange={(next) => onToggle(item.id, next)}>
        {line(
          <CollapsibleTrigger
            aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
            className='flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
          >
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </CollapsibleTrigger>,
        )}
        <CollapsibleContent className='mt-0.5'>
          <OutlineRows
            items={item.members ?? []}
            depth={depth + 1}
            selectedId={selectedId}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
            onRowContextMenu={onRowContextMenu}
            rowDrag={rowDrag}
            draggedId={draggedId}
          />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
