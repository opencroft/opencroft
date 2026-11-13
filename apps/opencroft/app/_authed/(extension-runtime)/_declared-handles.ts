// The handles a node has. Most come from its type's declaration; a few nodes'
// handles follow their data instead: a subgraph's are its ports, the core
// value nodes' are derived from their settings (Math Expression's variables,
// a Switch's cases), and a Call Action's inputs are its action's parameters.
// The canvas, connectNodes, the resolvers, the node checks and the agents'
// reads all ask here, so they agree on what a node has.
//
// Safe for both server and client — no runtime imports.

import { type EnumCasesOf, withEnumCases, withTypesNow } from '@opencroft/core/values'

import {
  callActionHandles,
  isCallAction,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/call-action-shared'
import {
  boundaryHandles,
  isSubgraph,
  subgraphHandles,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  valueNodeHandles,
  valueNodeTypeOf,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/value-nodes-shared'
import { type ExtensionHandle, findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

interface HandleNode {
  type?: string
  data?: unknown
}

/**
 * The handles a node declares: its type's, from `handlesOfType`, except a
 * subgraph's, which are its ports (see `subgraphHandles`), and a core value
 * node's and a Call Action's, which follow their data (see `valueNodeHandles`
 * and `callActionHandles`). An input that takes several types carries the
 * type it has now, from the node's `data.inputTypes` (see `withTypesNow`),
 * and a handle of an enum type the enum's cases, from `enumCasesOf` (see
 * `withEnumCases`).
 */
export function declaredHandlesOf(
  node: HandleNode,
  handlesOfType: (type: string) => readonly ExtensionHandle[],
  enumCasesOf: EnumCasesOf,
): ExtensionHandle[] {
  const data = node.data as Record<string, unknown> | undefined
  return withEnumCases(withTypesNow(ownHandlesOf(node, handlesOfType, enumCasesOf), data), enumCasesOf)
}

function ownHandlesOf(
  node: HandleNode,
  handlesOfType: (type: string) => readonly ExtensionHandle[],
  enumCasesOf: EnumCasesOf,
): ExtensionHandle[] {
  if (isSubgraph(node)) {
    return subgraphHandles(node.data)
  }
  if (isCallAction(node.type)) {
    return callActionHandles(node.data as Record<string, unknown> | undefined)
  }
  const valueNode = valueNodeTypeOf(node.type)
  if (valueNode) {
    return valueNodeHandles(valueNode, (node.data ?? {}) as Record<string, unknown>, enumCasesOf)
  }
  return node.type ? [...handlesOfType(node.type)] : []
}

/**
 * The source handle `handleId` of `node` as a wired edge leaves it. A
 * subgraph is a source only through an input port with no edge outside,
 * whose typed value feeds the nodes inside (see `wiredEdges`): the port's
 * handle on its Inputs boundary.
 */
export function sourceHandleOf(
  node: HandleNode,
  handleId: string,
  handlesOfType: (type: string) => readonly ExtensionHandle[],
  enumCasesOf: EnumCasesOf,
): ExtensionHandle | undefined {
  if (isSubgraph(node)) {
    return findExtensionHandle(withEnumCases(boundaryHandles(node.data, 'inputs'), enumCasesOf), handleId, 'source')
  }
  return findExtensionHandle(declaredHandlesOf(node, handlesOfType, enumCasesOf), handleId, 'source')
}
