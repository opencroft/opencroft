'use client'

import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'

import { CanvasNodesProvider } from '@/app/_authed/(dashboard)/_canvas/canvas-nodes-context'
import { GraphCanvasLoading } from '@/app/_authed/(extension-runtime)/_client/graph-canvas-loading'
import { SpaceCanvas } from '@/app/_authed/(space)/_components/space-canvas'
import { getGraphViewForInstance } from '@/app/_authed/(space)/_server/actions'
import type { GraphInstanceView } from '@/app/_authed/(space)/_server/actions-impl'

/**
 * The canvas behind a Graph App instance: the SAME surface the space's own
 * page draws (editor, chat, providers and all), pointed at the instance's
 * graph. The instance id is the only input -- the graph's address, names and
 * owning space are resolved server-side, so the client never re-derives a
 * slug from a parameter.
 *
 * That matters MORE since the slug started moving on rename,
 * not less: an already-open canvas holds the instance id, which a rename
 * cannot invalidate, so it keeps working while the address it was reached by
 * stops resolving. The identity is what makes the open session survive; the
 * address is what dies.
 *
 * Exposed through the host API for the builtin extension's App component --
 * the platform's window onto a graph is host UI, not something an extension
 * bundle could assemble from parts.
 */
export function GraphCanvas({ instanceId }: { instanceId: string }) {
  // undefined = resolving; null = the instance has no graph behind it.
  const [view, setView] = useState<GraphInstanceView | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setView(undefined)
    getGraphViewForInstance({ data: instanceId })
      .then((resolved) => {
        if (!cancelled) {
          setView(resolved)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setView(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [instanceId])

  if (view === undefined) {
    return <GraphCanvasLoading />
  }
  if (!view) {
    return (
      <Empty className='h-full'>
        <EmptyHeader>
          <EmptyTitle>This graph is not available</EmptyTitle>
          <EmptyDescription>The instance has no graph behind it — it may have failed to initialize.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className='h-full w-full'>
      <ReactFlowProvider>
        <CanvasNodesProvider>
          <SpaceCanvas slug={view.spaceSlug} spaceName={view.spaceName} graph={view.address} />
        </CanvasNodesProvider>
      </ReactFlowProvider>
    </div>
  )
}
