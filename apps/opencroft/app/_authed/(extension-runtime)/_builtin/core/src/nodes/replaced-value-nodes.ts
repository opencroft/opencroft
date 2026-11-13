// Value nodes a graph can hold from before Value and Convert: Text, Number and
// Boolean are a Value of that type, To Number and To Boolean a Convert to it.
// A graph holding one is converted as it is normalised (see `withWholeTree` in
// graph-collab.ts), so every graph is converted as the server starts and any
// graph written since: each node keeps its id, place and value, and its edges
// move onto the Convert's handles.
//
// Pure: no runtime imports.

import {
  AWAITING_RUN_KEY,
  BOOLEAN_TYPE,
  NUMBER_TYPE,
  RESOLVED_CONTEXTS_KEY,
  STRING_TYPE,
  UNRESOLVED_INPUTS_KEY,
} from '@opencroft/core/values'

import { VALUE_NODE, valueNodeQualifiedType } from './value-nodes-shared'

type Data = Record<string, unknown>

interface Replacement {
  /** The replacement's type, qualified as graphs store it. */
  type: string
  valueType: string
  /** The handles the node had, by the id each has on its replacement. */
  handles?: { source?: Record<string, string>; target?: Record<string, string> }
}

const VALUE = valueNodeQualifiedType(VALUE_NODE.value)
const CONVERT = valueNodeQualifiedType(VALUE_NODE.convert)

/** The replaced types, qualified as graphs store them, and what replaces each. */
export const REPLACED_VALUE_NODES: Readonly<Record<string, Replacement>> = {
  'builtin.core.text-value': { type: VALUE, valueType: STRING_TYPE },
  'builtin.core.number-value': { type: VALUE, valueType: NUMBER_TYPE },
  'builtin.core.boolean-value': { type: VALUE, valueType: BOOLEAN_TYPE },
  'builtin.core.to-number': {
    type: CONVERT,
    valueType: NUMBER_TYPE,
    handles: { source: { number: 'value' }, target: { text: 'value' } },
  },
  'builtin.core.to-boolean': {
    type: CONVERT,
    valueType: BOOLEAN_TYPE,
    handles: { source: { boolean: 'value' } },
  },
}

interface GraphNode {
  id?: unknown
  type?: unknown
  data?: unknown
}

interface GraphEdge {
  source?: unknown
  target?: unknown
  sourceHandle?: unknown
  targetHandle?: unknown
}

/**
 * `graph` with every Text, Number, Boolean, To Number and To Boolean node
 * replaced by a Value or a Convert, and the edges on a renamed handle moved
 * onto its new id. Returns `graph` itself when it holds none.
 */
export function withReplacedValueNodes<N extends GraphNode, E extends GraphEdge, G extends { nodes: N[]; edges: E[] }>(
  graph: G,
): G {
  const replaced = new Map<string, Replacement>()
  const nodes = graph.nodes.map((node) => {
    const replacement =
      typeof node.type === 'string' && Object.hasOwn(REPLACED_VALUE_NODES, node.type)
        ? REPLACED_VALUE_NODES[node.type]
        : undefined
    if (!replacement || typeof node.id !== 'string') {
      return node
    }
    replaced.set(node.id, replacement)
    return { ...node, type: replacement.type, data: replacedData(isData(node.data) ? node.data : {}, replacement) }
  })
  if (replaced.size === 0) {
    return graph
  }
  const moved = (nodeId: unknown, handle: unknown, side: 'source' | 'target') => {
    const renames = typeof nodeId === 'string' ? replaced.get(nodeId)?.handles?.[side] : undefined
    return typeof handle === 'string' && renames && Object.hasOwn(renames, handle) ? renames[handle] : handle
  }
  const edges = graph.edges.map((edge) => {
    const sourceHandle = moved(edge.source, edge.sourceHandle, 'source')
    const targetHandle = moved(edge.target, edge.targetHandle, 'target')
    return sourceHandle === edge.sourceHandle && targetHandle === edge.targetHandle
      ? edge
      : { ...edge, sourceHandle, targetHandle }
  })
  return { ...graph, nodes, edges }
}

// The node's data as its replacement holds it: its value kept, the value typed
// into a renamed input moved to the input's new id. What the context
// resolution derived from its wired inputs is dropped: it is keyed by the old
// ids, and the resolution that follows the normalising writes it again.
function replacedData(data: Data, replacement: Replacement): Data {
  const {
    [RESOLVED_CONTEXTS_KEY]: _contexts,
    [UNRESOLVED_INPUTS_KEY]: _unresolved,
    [AWAITING_RUN_KEY]: _awaiting,
    ...kept
  } = data
  const renames = replacement.handles?.target ?? {}
  const inputs = isData(kept.inputs)
    ? Object.fromEntries(
        Object.entries(kept.inputs).map(([id, value]) => [Object.hasOwn(renames, id) ? renames[id] : id, value]),
      )
    : undefined
  return { ...kept, ...(inputs ? { inputs } : {}), valueType: replacement.valueType }
}

function isData(value: unknown): value is Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
