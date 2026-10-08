'use client'

import type { Node } from '@xyflow/react'
import { Box, GripVertical, List, Maximize2, MessageCircleQuestion, Minimize2, Pencil, X } from 'lucide-react'
import { type DragEvent, type ReactNode, useCallback } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'
import { PanelTabStrip } from 'ui/layouts/panel-tab-strip'
import { Separator } from 'ui/separator'

import { McpRequestList } from '@/app/_authed/(approvals)/_components/mcp-request-list'
import { inspectorIntent, useInspectorIntent } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { InspectorTabBody } from '@/app/_authed/(dashboard)/_canvas/inspector-tab-body'
import { NodeCommentTab } from '@/app/_authed/(dashboard)/_canvas/node-comment-tab'
import { InstallMissingExtension, missingTypeLabel } from '@/app/_authed/(extension-runtime)/_client/missing-extension'
import {
  editableFolderOf,
  extensionRegistry,
  type ResolvedNode,
  resolveIcon,
} from '@/app/_authed/(extension-runtime)/_client/registry'
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
  onExpandedChange: (next: boolean) => void
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
  const intent = useInspectorIntent(node?.id ?? '')

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

  const resolved = node.type ? extensionRegistry.resolveNode(node.type) : undefined
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
  // type's own tabs go between them.
  const tabs = [
    { id: 'details', label: 'Details', icon: 'Settings', fullHeight: false, component: Inspector },
    ...(resolved.inspectorTabs ?? []).map((tab) => ({ ...tab, fullHeight: Boolean(tab.fullHeight) })),
    { id: 'comment', label: 'Comment', icon: 'MessageSquare', fullHeight: false, component: NodeCommentTab },
  ]

  // The node's tab lives in the intent store, not in state here: the node's
  // own buttons write it, the tab strip below writes it, and this reads it.
  // A copy in state was what reopened the terminal on every reselection: the
  // button's request outlived the user's later pick of Details.
  const activeEntry = tabs.find((t) => t.id === intent.tab) ?? tabs[0]

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
        <Button
          variant='ghost'
          size='icon'
          onClick={() => onExpandedChange(!expanded)}
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <ExpandIcon />
        </Button>
        <Button variant='ghost' size='icon' onClick={onDeselect} title='Close'>
          <X />
        </Button>
      </Flex>
      <Separator />
      <PanelTabStrip
        tabs={tabs.map((tab) => ({ id: tab.id, label: tab.label, icon: resolveIcon(tab.icon) }))}
        activeId={activeEntry.id}
        onSelect={(id) => inspectorIntent.setTab(node.id, id)}
      />
      <InspectorTabBody nodeId={node.id} tabs={tabs} active={activeEntry} inspectorProps={inspectorProps} />
    </Flex>
  )
}

interface NodeBrowserProps {
  tab: BrowserTab
  extensions: ResolvedNode[]
  graphNodes: Node<NodeData>[]
  onTabChange: (tab: BrowserTab) => void
  onEditExtension: (folder: string) => void
  onFocusNode: (nodeId: string) => void
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
  onTabChange,
  onEditExtension,
  onFocusNode,
}: NodeBrowserProps) {
  const { pendingApprovals, pendingAskUsers } = useSSEEvents()
  const pendingCount = pendingApprovals.size + pendingAskUsers.size

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
      {tab === 'outline' && <OutlineTab graphNodes={graphNodes} onFocusNode={onFocusNode} />}
      {tab === 'palette' && <PaletteTab extensions={extensions} onEditExtension={onEditExtension} />}
      {tab === 'mcp' && <McpRequestList />}
    </Flex>
  )
}

function OutlineTab({
  graphNodes,
  onFocusNode,
}: {
  graphNodes: Node<NodeData>[]
  onFocusNode: (nodeId: string) => void
}) {
  if (graphNodes.length === 0) {
    return (
      <Flex expanded align='center' justify='center' className='p-4'>
        <p className='text-xs text-muted-foreground italic'>No nodes on the graph.</p>
      </Flex>
    )
  }

  return (
    <ScrollArea className='h-full'>
      <ul className='py-1'>
        {graphNodes.map((node) => {
          const resolved = node.type ? extensionRegistry.resolveNode(node.type) : undefined
          const data = (node.data ?? {}) as Record<string, unknown>
          const label = (data.name as string) || (data.title as string) || resolved?.name || node.id
          const NodeIcon = resolved?.icon ?? Box
          const accent = resolved?.accent

          return (
            <li key={node.id}>
              <button
                type='button'
                onClick={() => onFocusNode(node.id)}
                className='w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent/50 transition-colors rounded-sm'
              >
                <NodeIcon className='size-4 shrink-0' style={accent ? { color: accent } : undefined} />
                <span className='truncate flex-1'>{label}</span>
                {resolved && (
                  <span className='text-[10px] text-muted-foreground truncate max-w-24'>{resolved.name}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </ScrollArea>
  )
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
