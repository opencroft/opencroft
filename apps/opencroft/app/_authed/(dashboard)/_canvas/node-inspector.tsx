'use client'

import { nodeName } from '@opencroft/core/values'
import type { Node } from '@xyflow/react'
import { Box, GripVertical, List, Maximize2, MessageCircleQuestion, Minimize2, Pencil, X } from 'lucide-react'
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'
import { PanelTabStrip } from 'ui/layouts/panel-tab-strip'
import { GraphOutline, type GraphOutlineProps } from 'ui/nodes/graph-outline'
import { Separator } from 'ui/separator'

import { McpRequestList } from '@/app/_authed/(approvals)/_components/mcp-request-list'
import { inspectorTabs, useInspectorTab } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { InspectorTabBody } from '@/app/_authed/(dashboard)/_canvas/inspector-tab-body'
import { NodeCommentTab } from '@/app/_authed/(dashboard)/_canvas/node-comment-tab'
import { InspectedNodeErrors, NODE_ERRORS_TAB, NodeErrorsTab } from '@/app/_authed/(dashboard)/_canvas/node-errors-tab'
import {
  collapsedRows,
  foldsFor,
  foldsShowingLevel,
  NO_FOLDS,
  type OutlineEntry,
  type OutlineFolds,
  outlineTree,
} from '@/app/_authed/(dashboard)/_canvas/outline-tree'
import { useNodeErrors } from '@/app/_authed/(dashboard)/_canvas/use-node-errors'
import { InstallMissingExtension, missingTypeLabel } from '@/app/_authed/(extension-runtime)/_client/missing-extension'
import {
  editableFolderOf,
  extensionRegistry,
  type ResolvedNode,
  resolveIcon,
} from '@/app/_authed/(extension-runtime)/_client/registry'
import { byIdOf } from '@/app/_authed/(extension-runtime)/_frame-tree'
import type { NodeData } from '@/app/_authed/(extension-runtime)/_types'
import { useSSEEvents } from '@/app/_authed/(sse)/_lib/sse-events-store'

export type BrowserTab = 'outline' | 'palette' | 'mcp'

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

function handlePaletteDragStart(e: DragEvent<HTMLButtonElement>, type: string) {
  e.dataTransfer.setData('application/dashboard-extension', type)
  e.dataTransfer.effectAllowed = 'move'
}

interface NodeInspectorProps {
  node: Node<NodeData> | null
  expanded: boolean
  override?: ReactNode
  updateNodeData: (nodeId: string, patch: Partial<NodeData>) => void
  onDeselect: () => void
  onEditExtension: (folder: string) => void
  /** Omitted where the inspector already covers the screen (a phone): no Expand button then. */
  onExpandedChange?: (next: boolean) => void
}

// The selected node's inspector. With nothing selected there is nothing to
// inspect: the graph's outline, palette and MCP requests live in the page's
// sidebar (NodeBrowser), not here.
export function NodeInspector({
  node,
  expanded,
  override,
  updateNodeData,
  onDeselect,
  onEditExtension,
  onExpandedChange,
}: NodeInspectorProps) {
  const resolved = node?.type ? extensionRegistry.resolveNode(node.type) : undefined
  const rememberedTab = useInspectorTab(resolved?.type ?? '')
  const errors = useNodeErrors(node)

  const copyNodeId = useCallback(() => {
    if (!node) {
      return
    }
    navigator.clipboard.writeText(node.id).then(() => {
      toast.success('Copied to clipboard', { description: node.id, duration: 2000 })
    })
  }, [node])

  if (override) {
    return (
      <Flex expanded className='w-full h-full bg-card'>
        {override}
      </Flex>
    )
  }

  if (!node) {
    return null
  }

  if (!resolved) {
    return (
      <Flex expanded className='w-full h-full bg-card p-3'>
        <p className='text-destructive text-xs'>{missingTypeLabel(node.type ?? '')}</p>
        {node.type ? <InstallMissingExtension type={node.type} className='mt-2 self-start' /> : null}
      </Flex>
    )
  }

  const Icon = resolved.icon
  const Inspector = resolved.inspector
  const editableFolder = editableFolderOf(resolved)

  // Every node has Details first and Comment last, whatever its type; the
  // type's own tabs go between them. Errors comes right after Details, and
  // only while the node has any: its count is what says the node is in error.
  const tabs = [
    {
      id: 'details',
      label: 'Details',
      icon: 'Settings',
      fullHeight: Boolean(resolved.inspectorFullHeight),
      component: Inspector,
    },
    ...(errors.length > 0
      ? [
          {
            id: NODE_ERRORS_TAB,
            label: 'Errors',
            icon: 'CircleAlert',
            fullHeight: false,
            count: errors.length,
            component: NodeErrorsTab,
          },
        ]
      : []),
    ...(resolved.inspectorTabs ?? []).map((tab) => ({ ...tab, fullHeight: Boolean(tab.fullHeight) })),
    { id: 'comment', label: 'Comment', icon: 'MessageSquare', fullHeight: false, component: NodeCommentTab },
  ]

  // The tab is remembered per node type in the intent store, not in state
  // here: the nodes' own buttons write it, the tab strip below writes it, and
  // this reads it, so the latest of those wins on every node of the type. A
  // node without the remembered tab (Errors on a node with none, a tab some
  // nodes of the type lack) shows Details, and the remembered tab stays for
  // the next node that has it.
  const activeEntry = tabs.find((t) => t.id === rememberedTab) ?? tabs[0]

  const inspectorProps = {
    nodeId: node.id,
    data: node.data,
    updateData: (patch: Record<string, unknown>) => updateNodeData(node.id, patch),
  }

  const ExpandIcon = expanded ? Minimize2 : Maximize2

  return (
    <Flex expanded className='w-full h-full bg-card'>
      <Flex row align='center' withPadding className='gap-2 p-3'>
        <Icon className='size-4 shrink-0' style={{ color: resolved.accent }} />
        <div className='flex-1 min-w-0'>
          <span className='text-sm font-semibold truncate block'>{resolved.name}</span>
          <button
            type='button'
            className='text-[10px] text-muted-foreground hover:text-foreground transition-colors truncate block text-left w-full cursor-pointer font-mono'
            onClick={copyNodeId}
            title='Click to copy node ID'
          >
            {node.id}
          </button>
        </div>
        {editableFolder && (
          <Button
            variant='ghost'
            size='icon'
            title='Edit extension source'
            onClick={() => onEditExtension(editableFolder)}
          >
            <Pencil />
          </Button>
        )}
        {/* Same size as the embedded chat header's buttons (ChatDock). */}
        {onExpandedChange && (
          <Button
            variant='ghost'
            size='icon'
            onClick={() => onExpandedChange(!expanded)}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <ExpandIcon />
          </Button>
        )}
        <Button variant='ghost' size='icon' onClick={onDeselect} title='Close'>
          <X />
        </Button>
      </Flex>
      <Separator />
      <PanelTabStrip
        tabs={tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          icon: resolveIcon(tab.icon),
          count: 'count' in tab ? tab.count : undefined,
        }))}
        activeId={activeEntry.id}
        onSelect={(id) => inspectorTabs.set(resolved.type, id)}
      />
      <InspectedNodeErrors.Provider value={errors}>
        <InspectorTabBody
          nodeId={node.id}
          nodeType={resolved.type}
          tabs={tabs}
          active={activeEntry}
          inspectorProps={inspectorProps}
        />
      </InspectedNodeErrors.Provider>
    </Flex>
  )
}

interface NodeBrowserProps {
  tab: BrowserTab
  extensions: ResolvedNode[]
  graphNodes: Node<NodeData>[]
  /** The open level, a subgraph's id or undefined for the top level: its rows are shown when it opens. */
  level: string | undefined
  /** The selected node, whose row the Outline shows. */
  selectedNodeId: string | null
  /** Whether a node is a frame, listed in the Outline with its members. */
  isFrame: (node: Node<NodeData>) => boolean
  onTabChange: (tab: BrowserTab) => void
  onEditExtension: (folder: string) => void
  onFocusNode: (nodeId: string) => void
  /** A node's row dragged in the Outline to a new place. */
  onMoveNode: GraphOutlineProps['onMove']
  /** A node's row asking for the node's context menu, at a point on the screen. */
  onNodeMenu: GraphOutlineProps['onRowContextMenu']
}

const browserTabs = [
  { id: 'outline', label: 'Outline', icon: List },
  { id: 'palette', label: 'Palette', icon: GripVertical },
  { id: 'mcp', label: 'MCP Requests', icon: MessageCircleQuestion },
] as const

export function NodeBrowser({
  tab,
  extensions,
  graphNodes,
  level,
  selectedNodeId,
  isFrame,
  onTabChange,
  onEditExtension,
  onFocusNode,
  onMoveNode,
  onNodeMenu,
}: NodeBrowserProps) {
  const { pendingApprovals, pendingAskUsers } = useSSEEvents()
  const pendingCount = pendingApprovals.size + pendingAskUsers.size
  // Here rather than in the Outline, so going to another tab here and back
  // keeps which rows are folded. Never stored: each page starts with every
  // frame expanded and every subgraph collapsed but the open level's.
  const [folds, setFolds] = useState<OutlineFolds>(NO_FOLDS)
  const collapsed = useMemo(() => collapsedRows(folds, graphNodes), [folds, graphNodes])
  // Read when a level opens, not a reason to show it again: keyed on the
  // nodes, a row folded on the open level would reopen at every graph change.
  const nodesRef = useRef(graphNodes)
  nodesRef.current = graphNodes
  useEffect(() => {
    setFolds((now) => foldsShowingLevel(now, level, byIdOf(nodesRef.current)))
  }, [level])

  return (
    <Flex expanded className='w-full h-full'>
      <PanelTabStrip
        tabs={browserTabs.map((entry) => ({
          id: entry.id,
          label: entry.label,
          icon: entry.icon,
          count: entry.id === 'mcp' ? pendingCount : undefined,
        }))}
        activeId={tab}
        onSelect={(id) => onTabChange(id as BrowserTab)}
      />
      {tab === 'outline' && (
        <OutlineTab
          graphNodes={graphNodes}
          extensions={extensions}
          isFrame={isFrame}
          selectedId={selectedNodeId}
          collapsed={collapsed}
          onCollapsedChange={(next) => setFolds(foldsFor(next, graphNodes))}
          onSelect={onFocusNode}
          onMove={onMoveNode}
          onRowContextMenu={onNodeMenu}
        />
      )}
      {tab === 'palette' && <PaletteTab extensions={extensions} onEditExtension={onEditExtension} />}
      {tab === 'mcp' && <McpRequestList />}
    </Flex>
  )
}

/** What the Outline shows of a node: its name (see `nodeName`), and its type's icon and accent. */
function describeNode(node: Node<NodeData>): OutlineEntry {
  const resolved = node.type ? extensionRegistry.resolveNode(node.type) : undefined
  return {
    label: nodeName(node.data, resolved?.name, node.id),
    typeName: resolved?.name,
    icon: resolved?.icon ?? Box,
    accent: resolved?.accent,
  }
}

// The canvas's tree: frames with their members under them (see outlineTree).
function OutlineTab({
  graphNodes,
  extensions,
  isFrame,
  ...outline
}: Pick<NodeBrowserProps, 'graphNodes' | 'extensions' | 'isFrame'> &
  Pick<
    GraphOutlineProps,
    'selectedId' | 'collapsed' | 'onCollapsedChange' | 'onSelect' | 'onMove' | 'onRowContextMenu'
  >) {
  // `extensions` for its identity: a node is described from the registry,
  // which is not reactive, and a new list is how this learns it changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: extensions is the registry's change signal
  const items = useMemo(() => outlineTree(graphNodes, isFrame, describeNode), [graphNodes, isFrame, extensions])
  return <GraphOutline items={items} {...outline} />
}

function PaletteTab({
  extensions,
  onEditExtension,
}: {
  extensions: ResolvedNode[]
  onEditExtension: (folder: string) => void
}) {
  const groups = groupByCategory(extensions)

  if (extensions.length === 0) {
    return (
      <Flex expanded align='center' justify='center' className='p-4'>
        <p className='text-xs text-muted-foreground italic'>No nodes registered.</p>
      </Flex>
    )
  }

  return (
    <ScrollArea className='h-full'>
      {Array.from(groups.entries()).map(([category, items]) => (
        <div key={category}>
          <div className='px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground'>{category}</div>
          {items.map((node) => {
            const Icon = node.icon
            const editableFolder = editableFolderOf(node)
            return (
              <div key={node.type} className='group relative flex items-center hover:bg-accent/50'>
                <button
                  type='button'
                  title={node.description ?? node.name}
                  draggable
                  onDragStart={(e) => handlePaletteDragStart(e, node.type)}
                  className='flex-1 flex items-center gap-2 px-3 py-1.5 text-xs text-left'
                >
                  <Icon className='size-3.5 shrink-0' style={{ color: node.accent }} />
                  <span className='truncate'>{node.name}</span>
                </button>
                {editableFolder && (
                  <Button
                    size='icon'
                    variant='ghost'
                    className='size-5 mr-1 opacity-0 group-hover:opacity-100'
                    title='Edit extension'
                    onClick={() => onEditExtension(editableFolder)}
                  >
                    <Pencil className='size-3' />
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </ScrollArea>
  )
}
