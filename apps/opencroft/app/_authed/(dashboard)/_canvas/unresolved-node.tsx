'use client'

import { Handle, Position, useEdges, useNodeId } from '@xyflow/react'
import { useMemo } from 'react'
import { NodeLoadingPlaceholder } from 'ui/nodes/node-loading-placeholder'

import { edgeHandleIds } from '@/app/_authed/(dashboard)/_canvas/edge-handles'
import { NODE_CARD_MIN_WIDTH } from '@/app/_authed/(dashboard)/_canvas/node-card'

interface UnresolvedNodeProps {
  /** The node type the graph asked for, which nothing has claimed. */
  type: string
  /** The node's own name. The graph carries it before its extension exists. */
  name?: string
  /** Whether extension loading has finished — successfully or not. */
  settled: boolean
}

/**
 * The anchors the graph says this node has.
 *
 * Not the same thing as `node-frame`'s stale handles, which are drawn in the
 * destructive colour with their id shown: there, a handle referenced but not
 * declared means the extension dropped it. Here it means the extension has not
 * spoken yet, so these are silent.
 */
function useEdgeHandles(): { source: string[]; target: string[] } {
  const nodeId = useNodeId()
  const edges = useEdges()
  return useMemo(() => edgeHandleIds(edges, nodeId), [edges, nodeId])
}

/**
 * A node whose type no extension has claimed.
 *
 * Two states live here and they must not look alike. Still loading is transient
 * and needs nobody to do anything; genuinely missing is a fault someone has to
 * act on. A transient state wearing the fault's appearance is precisely how
 * people are taught to ignore the fault.
 *
 * Which state applies is decided by whether extension loading has FINISHED,
 * never by how long it has been going. Elapsed time would paint a healthy node
 * as broken on a slow connection, which is the failure this design exists to
 * avoid.
 */
export function UnresolvedNode({ type, name, settled }: UnresolvedNodeProps) {
  const handles = useEdgeHandles()
  return (
    // One box for both states, and it is the host's to define — the placeholder
    // deliberately carries no size of its own, and a node element on this canvas
    // has no width or height either. Sharing it matters more than its exact
    // value: if the two states were sized by their own content, a node whose
    // extension is genuinely absent would shrink the moment loading settled,
    // moving itself and every edge endpoint on it. That is the jump this whole
    // design exists to prevent, and it would have survived in the failure path.
    //
    // The width is DEFINITE, not a range, for the same reason: a shared min/max
    // is not a shared size, since each state was still sized by its own text
    // inside those bounds — measured as the placeholder sitting at the minimum
    // and the longer "Unknown extension: …" pushed out to the maximum. A
    // definite width cannot be pushed by content, so neither state can widen
    // the other out of step. The value is the node shell's own exported
    // minimum now, not a copied number, so it cannot drift out of step with it.
    //
    // `relative` because the handles below are positioned against this box.
    <div className='relative h-24' style={{ width: NODE_CARD_MIN_WIDTH }}>
      {/* Rendered in both states: a node whose extension is never coming still
          has edges, and they still need somewhere to land. */}
      {handles.target.map((id) => (
        <Handle key={`target:${id}`} id={id} type='target' position={Position.Left} />
      ))}
      {handles.source.map((id) => (
        <Handle key={`source:${id}`} id={id} type='source' position={Position.Right} />
      ))}
      {settled ? (
        /* `truncate` because the box no longer grows to fit: without it a long
           type id would simply overflow the node. `title` keeps the full id
           reachable for whoever is actually debugging it — nobody needs to read
           a type id in full to know what is wrong, but the one person who does
           should not have to go to the console for it. */
        <div
          title={type}
          className='truncate rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs'
        >
          Unknown extension: {type}
        </div>
      ) : (
        // The type is the fallback name because it is the only other thing known
        // about a node nothing has claimed, and an empty label would leave the
        // placeholder announcing ", loading" to a screen reader.
        <NodeLoadingPlaceholder name={name ?? type} />
      )}
    </div>
  )
}
