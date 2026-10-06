// Binds a live graph (live-graph.ts) to the canvas: changes others make are
// merged into the canvas's nodes and edges as they arrive, and the canvas's
// own changes are written back. `live` is null until the graph's document is
// open.
//
// A write carries only what this tab changed. Its base is the graph the
// committed canvas state was derived from, held in React state beside the
// nodes and edges and advanced in the same update as the merge that brings a
// remote change in -- so a change already in the document but not yet
// rendered is never written back over, and an element the tab does not hold
// yet is never deleted.

import type { Edge, Node } from '@xyflow/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { liveGraphOf, mergeRemoteEdges, mergeRemoteNodes } from '@/app/_authed/(dashboard)/_canvas/graph-view-state'
import { LiveGraph } from '@/app/_authed/(dashboard)/_canvas/live-graph'
import { fetchSpaceGraph } from '@/app/_authed/(space)/_components/space-client'
import type { LiveGraphSession } from '@/app/_authed/(space)/_lib/graph-collab-protocol'
import { applyGraphChange } from '@/app/_authed/(space)/_lib/graph-doc'
import type { GraphUndoResult } from '@/app/_authed/(space)/_lib/graph-undo'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

export interface LiveGraphStart {
  session: LiveGraphSession
  /** The graph as fetched alongside the session. */
  graph: GraphData
}

export interface LiveGraphBinding {
  live: LiveGraph | null
  /**
   * Asks for the canvas's state to be written once the render it is part of
   * has committed; every request until then is one write, and so one step.
   * `mergeKey` joins that step to the one before (see GraphUndo.beginStep);
   * requests with different keys in one render start a step of their own.
   */
  requestWrite: (mergeKey?: string) => void
}

export function useLiveGraph({
  slug,
  start,
  nodes,
  edges,
  setNodes,
  setEdges,
}: {
  slug: string
  start: LiveGraphStart | null
  nodes: Node[]
  edges: Edge[]
  setNodes: (update: (nodes: Node[]) => Node[]) => void
  setEdges: (update: (edges: Edge[]) => Edge[]) => void
}): LiveGraphBinding {
  // A stale lineage replaces the start the canvas loaded with a fresh one.
  const [current, setCurrent] = useState(start)
  const [live, setLive] = useState<LiveGraph | null>(null)
  const [base, setBase] = useState<GraphData | null>(start?.graph ?? null)
  const pending = useRef<{ mergeKey?: string } | null>(null)

  useEffect(() => setCurrent(start), [start])

  useEffect(() => {
    if (!current) {
      setLive(null)
      setBase(null)
      return
    }
    let active = true
    setBase(current.graph)
    const graph = new LiveGraph({
      session: current.session,
      initial: current.graph,
      onRemoteChange: (before, after) => {
        // One update: the merged state and the base it is derived from
        // commit together.
        setNodes((ns) => mergeRemoteNodes(before, after, ns))
        setEdges((es) => mergeRemoteEdges(before, after, es))
        setBase(after)
      },
      onStale: () => {
        void fetchSpaceGraph(slug).then(({ graph: fresh, live: session }) => {
          if (active) {
            setCurrent(session ? { session, graph: fresh } : null)
          }
        })
      },
    })
    setLive(graph)
    return () => {
      active = false
      graph.destroy()
      setLive(null)
    }
  }, [slug, current, setNodes, setEdges])

  const requestWrite = useCallback((mergeKey?: string) => {
    const previous = pending.current
    pending.current = { mergeKey: !previous || previous.mergeKey === mergeKey ? mergeKey : undefined }
  }, [])

  useEffect(() => {
    const request = pending.current
    if (!live || !base || !request) {
      return
    }
    pending.current = null
    const next = liveGraphOf(nodes, edges, base)
    live.write(next, base, request.mergeKey)
    // The written change, applied to whatever base this update lands on: the
    // same graph when nothing arrived meanwhile, and otherwise the newer one
    // a remote change has just committed.
    setBase((latest) => (latest === base || !latest ? next : applyGraphChange(latest, base, next)))
  }, [live, nodes, edges, base])

  return { live, requestWrite }
}

/**
 * What to tell the person after an undo or redo, or null when it simply did
 * what was asked. Undo never overwrites or strands what others did since, so
 * when it holds back the person is told why.
 */
export function describeUndoResult(
  result: GraphUndoResult | null,
  action: 'undo' | 'redo',
  nameOf: (nodeId: string) => string,
): string | null {
  if (!result) {
    return null
  }
  if (result.keptNodeIds.length > 0) {
    const names = result.keptNodeIds.map(nameOf).join(', ')
    return `Kept ${names}: someone has since connected to it or placed a node in it.`
  }
  if (!result.applied) {
    return action === 'undo'
      ? 'Nothing to undo there: someone else has since changed it.'
      : 'Nothing to redo there: someone else has since changed it.'
  }
  return null
}
