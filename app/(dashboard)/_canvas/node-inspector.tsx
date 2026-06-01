'use client'

import type { Node } from '@xyflow/react'
import * as lucideIcons from 'lucide-react'
import { Box, GripVertical, List, Maximize2, Minimize2, Pencil, X } from 'lucide-react'
import { type DragEvent, type ReactNode, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useInspectorIntent } from '@/app/(dashboard)/_canvas/inspector-intent'
import { extensionRegistry, type ResolvedNode } from '@/app/(extension-runtime)/_client/registry'
import type { NodeData } from '@/app/(extension-runtime)/_types'
import { Button } from '@/components/ui/button'
import { Flex } from '@/components/ui/layout/flex'
import { ScrollArea } from '@/components/ui/layout/scroll-area'
import { Separator } from '@/components/ui/separator'

function resolveIcon(name?: string): lucideIcons.LucideIcon {
  if (!name) {
    return lucideIcons.Box
  }
  return (lucideIcons as unknown as Record<string, lucideIcons.LucideIcon>)[name] ?? lucideIcons.Box
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

function handlePaletteDragStart(e: DragEvent<HTMLButtonElement>, typeId: string) {
  e.dataTransfer.setData('application/dashboard-extension', typeId)
  e.dataTransfer.effectAllowed = 'move'
}

interface NodeInspectorProps {
  node: Node<NodeData> | null
  expanded: boolean
  extensions: ResolvedNode[]
  graphNodes: Node<NodeData>[]
  override?: ReactNode
  updateNodeData: (nodeId: string, patch: Partial<NodeData>) => void
  onDeselect: () => void
  onEditExtension: (extensionId: string) => void
  onNewExtension: () => void
  onExpandedChange: (next: boolean) => void
  onFocusNode: (nodeId: string) => void
}

export function NodeInspector({ node, expanded, extensions, graphNodes, override, updateNodeData, onDeselect, onEditExtension, onNewExtension, onExpandedChange, onFocusNode }: NodeInspectorProps) {
  const [activeTab, setActiveTab] = useState<string>('details')
  const intent = useInspectorIntent(node?.id ?? '')

  const copyNodeId = useCallback(() => {
    if (!node) {
      return
    }
    navigator.clipboard.writeText(node.id).then(() => {
      toast.success('Copied to clipboard', { description: node.id, duration: 2000 })
    })
  }, [node?.id])

  useEffect(() => {
    if (intent.tab) {
      setActiveTab(intent.tab)
    }
  }, [intent.tabRequestId, intent.tab])

  if (override) {
    return (
      <Flex expanded className='w-full h-full bg-card'>
        {override}
      </Flex>
    )
  }

  if (!node) {
    return <NodeBrowser extensions={extensions} graphNodes={graphNodes} onEditExtension={onEditExtension} onFocusNode={onFocusNode} />
  }

  const resolved = extensionRegistry.resolveNode(node.type!)
  if (!resolved) {
    return (
      <Flex expanded className='w-full h-full bg-card p-3'>
        <p className='text-destructive text-xs'>Unknown extension: {node.type}</p>
      </Flex>
    )
  }

  const Icon = resolved.icon
  const Inspector = resolved.inspector
  const inspectorTabs = resolved.inspectorTabs
  const isLocal = resolved.extension.manifest.id.startsWith('local/')
  const hasTabs = inspectorTabs && inspectorTabs.length > 0

  const tabs = hasTabs
    ? [{ id: 'details', label: 'Details', icon: 'Settings' as const, fullHeight: false, component: Inspector }, ...inspectorTabs.map((tab) => ({ ...tab, fullHeight: Boolean(tab.fullHeight) }))]
    : []

  const activeEntry = hasTabs ? tabs.find((t) => t.id === activeTab) : null
  const ActiveComponent = activeEntry?.component ?? Inspector
  const fillHeight = activeEntry?.fullHeight ?? false

  const inspectorProps = {
    nodeId: node.id,
    data: node.data,
    updateData: (patch: Record<string, unknown>) => updateNodeData(node.id, patch),
  }

  const body = fillHeight ? (
    <Flex expanded className='w-full min-h-0'>
      {ActiveComponent ? <ActiveComponent {...inspectorProps} /> : <p className='text-xs text-muted-foreground italic p-2'>This extension has no editable properties.</p>}
    </Flex>
  ) : (
    <ScrollArea className='flex-1 min-h-0'>
      <div className='py-2 px-4'>{ActiveComponent ? <ActiveComponent {...inspectorProps} /> : <p className='text-xs text-muted-foreground italic'>This extension has no editable properties.</p>}</div>
    </ScrollArea>
  )

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
        {isLocal && (
          <Button variant='ghost' size='icon' className='size-6' title='Edit extension source' onClick={() => onEditExtension(resolved.extension.manifest.id)}>
            <Pencil className='size-3.5' />
          </Button>
        )}
        <Button variant='ghost' size='icon' className='size-6' onClick={() => onExpandedChange(!expanded)} title={expanded ? 'Collapse' : 'Expand'}>
          <ExpandIcon className='size-3.5' />
        </Button>
        <Button variant='ghost' size='icon' className='size-6' onClick={onDeselect} title='Close'>
          <X className='size-3.5' />
        </Button>
      </Flex>
      <Separator />
      {hasTabs && (
        <>
          <Flex row className='items-center gap-0 px-3 pt-2 pb-0'>
            {tabs.map((tab) => {
              const TabIcon = resolveIcon(tab.icon)
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  type='button'
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors',
                    isActive ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground/80',
                  ].join(' ')}
                >
                  <TabIcon className='size-3' />
                  {tab.label}
                </button>
              )
            })}
          </Flex>
          <Separator />
        </>
      )}
      {body}
    </Flex>
  )
}

interface NodeBrowserProps {
  extensions: ResolvedNode[]
  graphNodes: Node<NodeData>[]
  onEditExtension: (extensionId: string) => void
  onFocusNode: (nodeId: string) => void
}

function NodeBrowser({ extensions, graphNodes, onEditExtension, onFocusNode }: NodeBrowserProps) {
  const [tab, setTab] = useState<'outline' | 'palette'>('outline')

  return (
    <Flex expanded className='w-full h-full bg-card'>
      <div className='px-3 py-3'>
        <span className='text-sm font-semibold'>Inspector</span>
      </div>
      <Separator />
      <Flex row className='items-center gap-0 px-3 pt-2 pb-0'>
        <button
          type='button'
          onClick={() => setTab('outline')}
          className={[
            'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors',
            tab === 'outline' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground/80',
          ].join(' ')}
        >
          <List className='size-3' />
          Outline
        </button>
        <button
          type='button'
          onClick={() => setTab('palette')}
          className={[
            'flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors',
            tab === 'palette' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground/80',
          ].join(' ')}
        >
          <GripVertical className='size-3' />
          Palette
        </button>
      </Flex>
      <Separator />
      {tab === 'outline' ? <OutlineTab graphNodes={graphNodes} onFocusNode={onFocusNode} /> : <PaletteTab extensions={extensions} onEditExtension={onEditExtension} />}
    </Flex>
  )
}

function OutlineTab({ graphNodes, onFocusNode }: { graphNodes: Node<NodeData>[]; onFocusNode: (nodeId: string) => void }) {
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
              <button type='button' onClick={() => onFocusNode(node.id)} className='w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent/50 transition-colors rounded-sm'>
                <NodeIcon className='size-4 shrink-0' style={accent ? { color: accent } : undefined} />
                <span className='truncate flex-1'>{label}</span>
                {resolved && <span className='text-[10px] text-muted-foreground truncate max-w-24'>{resolved.name}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </ScrollArea>
  )
}

function PaletteTab({ extensions, onEditExtension }: { extensions: ResolvedNode[]; onEditExtension: (extensionId: string) => void }) {
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
            const isLocal = node.extension.manifest.id.startsWith('local/')
            return (
              <div key={node.typeId} className='group relative flex items-center hover:bg-accent/50'>
                <button
                  title={node.description ?? node.name}
                  draggable
                  onDragStart={(e) => handlePaletteDragStart(e, node.typeId)}
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
      ))}
    </ScrollArea>
  )
}
