'use client'

import { type ComponentType, memo, useState } from 'react'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'

import { RenderBoundary } from '@/components/render-boundary'

export interface InspectorTabEntry {
  id: string
  fullHeight: boolean
  keepMounted?: boolean
  // biome-ignore lint/suspicious/noExplicitAny: a tab's component takes whatever its extension's node data is
  component?: ComponentType<any>
}

interface InspectorTabBodyProps {
  nodeId: string
  /** The node's qualified type, which names a tab that fails to render. */
  nodeType: string
  tabs: InspectorTabEntry[]
  active: InspectorTabEntry
  /** The node's data, given to the tab as it is: a tab renders again only when this or `updateData` changes. */
  data: unknown
  updateData: (patch: Record<string, unknown>) => void
}

/**
 * The inspected node's active tab. A tab that asks to be kept mounted stays mounted, hidden, once
 * it has been opened for this node, so switching tabs does not unmount it; moving to another node
 * or closing the inspector does. A tab that throws while it renders shows the error in its place,
 * and the header, the tab strip and the other tabs stay usable.
 */
export function InspectorTabBody({ nodeId, nodeType, tabs, active, data, updateData }: InspectorTabBodyProps) {
  const [kept, setKept] = useState<{ nodeId: string; ids: string[] }>({ nodeId, ids: [] })
  const keptIds = kept.nodeId === nodeId ? kept.ids : []
  const ids = active.keepMounted && !keptIds.includes(active.id) ? [...keptIds, active.id] : keptIds
  if (kept.nodeId !== nodeId || ids !== kept.ids) {
    setKept({ nodeId, ids })
  }

  const contentOf = (tab: InspectorTabEntry) => (
    <TabContent
      component={tab.component}
      fullHeight={tab.fullHeight}
      tabId={tab.id}
      nodeId={nodeId}
      nodeType={nodeType}
      data={data}
      updateData={updateData}
    />
  )

  return (
    <>
      {ids.map((id) => {
        const tab = tabs.find((t) => t.id === id)
        return tab ? (
          <div key={`${nodeId}:${id}`} className={id === active.id ? 'flex flex-1 min-h-0 flex-col' : 'hidden'}>
            {contentOf(tab)}
          </div>
        ) : null
      })}
      {active.keepMounted ? null : contentOf(active)}
    </>
  )
}

interface TabContentProps {
  // biome-ignore lint/suspicious/noExplicitAny: a tab's component takes whatever its extension's node data is
  component?: ComponentType<any>
  fullHeight: boolean
  tabId: string
  nodeId: string
  nodeType: string
  data: unknown
  updateData: (patch: Record<string, unknown>) => void
}

/**
 * One tab's content. Memoized on plain values, not on the tab entry, which the inspector builds
 * afresh on each render: the inspector renders whenever its node object changes, and React Flow
 * replaces that object on every pointer move of a drag or a resize, while `data` keeps its
 * identity. So a move reaches the tab only through what the tab subscribes to itself.
 */
const TabContent = memo(function TabContent({
  component: Component,
  fullHeight,
  tabId,
  nodeId,
  nodeType,
  data,
  updateData,
}: TabContentProps) {
  const content = Component ? (
    <RenderBoundary scope='ext' label={nodeType} resetKey={`${nodeId}:${tabId}`}>
      <Component nodeId={nodeId} data={data} updateData={updateData} />
    </RenderBoundary>
  ) : (
    <p className={`text-xs text-muted-foreground italic${fullHeight ? ' p-2' : ''}`}>
      This extension has no editable properties.
    </p>
  )
  if (fullHeight) {
    return (
      <Flex expanded className='w-full min-h-0'>
        {content}
      </Flex>
    )
  }
  return (
    <ScrollArea className='flex-1 min-h-0'>
      <div className='py-2 px-4'>{content}</div>
    </ScrollArea>
  )
})
