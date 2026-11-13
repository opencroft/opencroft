'use client'

import { type ComponentType, useState } from 'react'
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
  inspectorProps: Record<string, unknown>
}

/**
 * The inspected node's active tab. A tab that asks to be kept mounted stays mounted, hidden, once
 * it has been opened for this node, so switching tabs does not unmount it; moving to another node
 * or closing the inspector does. A tab that throws while it renders shows the error in its place,
 * and the header, the tab strip and the other tabs stay usable.
 */
export function InspectorTabBody({ nodeId, nodeType, tabs, active, inspectorProps }: InspectorTabBodyProps) {
  const [kept, setKept] = useState<{ nodeId: string; ids: string[] }>({ nodeId, ids: [] })
  const keptIds = kept.nodeId === nodeId ? kept.ids : []
  const ids = active.keepMounted && !keptIds.includes(active.id) ? [...keptIds, active.id] : keptIds
  if (kept.nodeId !== nodeId || ids !== kept.ids) {
    setKept({ nodeId, ids })
  }

  return (
    <>
      {ids.map((id) => {
        const tab = tabs.find((t) => t.id === id)
        return tab ? (
          <div key={`${nodeId}:${id}`} className={id === active.id ? 'flex flex-1 min-h-0 flex-col' : 'hidden'}>
            <TabContent tab={tab} nodeId={nodeId} nodeType={nodeType} inspectorProps={inspectorProps} />
          </div>
        ) : null
      })}
      {active.keepMounted ? null : (
        <TabContent tab={active} nodeId={nodeId} nodeType={nodeType} inspectorProps={inspectorProps} />
      )}
    </>
  )
}

interface TabContentProps {
  tab: InspectorTabEntry
  nodeId: string
  nodeType: string
  inspectorProps: Record<string, unknown>
}

function TabContent({ tab, nodeId, nodeType, inspectorProps }: TabContentProps) {
  const Component = tab.component
  const content = Component ? (
    <RenderBoundary scope='ext' label={nodeType} resetKey={`${nodeId}:${tab.id}`}>
      <Component {...inspectorProps} />
    </RenderBoundary>
  ) : (
    <p className={`text-xs text-muted-foreground italic${tab.fullHeight ? ' p-2' : ''}`}>
      This extension has no editable properties.
    </p>
  )
  if (tab.fullHeight) {
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
}
