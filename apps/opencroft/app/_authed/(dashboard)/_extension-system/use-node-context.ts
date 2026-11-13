'use client'

import {
  inputValue,
  isEnumHandle,
  isPrimitiveType,
  isPrimitiveValue,
  type PrimitiveValue,
  type ValueHandle,
} from '@opencroft/core/values'
import { useRef } from 'react'

import {
  liveNodeData,
  resolveSourceContext,
  sameContext,
} from '@/app/_authed/(dashboard)/_extension-system/context-resolver'
import { type CanvasGraph, useCanvasGraph } from '@/app/_authed/(extension-runtime)/_client/canvas-graph'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import {
  type ExtensionHandle,
  findExtensionHandle,
  type ResolvedContext,
} from '@/app/_authed/(extension-runtime)/_types'
import { inputFeedOf } from '@/app/_authed/(extension-runtime)/_wired-edges'

/**
 * Whether an edge feeds `targetHandleId` of `nodeId`, and the context its
 * source exposes there (null while it exposes nothing). Through subgraph
 * ports to the real source, and on a subgraph's own input port from what is
 * wired into it outside (see `inputFeedOf`).
 */
function wiredInput(graph: CanvasGraph, nodeId: string, targetHandleId: string) {
  const edge = inputFeedOf(graph, nodeId, targetHandleId)
  const sourceNode = edge ? graph.nodes.find((n) => n.id === edge.source) : undefined
  const ctx = sourceNode && edge?.sourceHandle ? resolveSourceContext(sourceNode, edge.sourceHandle, graph) : null
  return { wired: edge !== undefined, ctx }
}

export function useNodeContext<V = unknown>(nodeId: string, targetHandleId: string): ResolvedContext<V> | null {
  const { ctx } = wiredInput(useCanvasGraph(), nodeId, targetHandleId)

  // The context can be built from anywhere upstream of the source, so it is
  // resolved against the whole graph on every change. The previous context is
  // kept while the new one has the same content, so moving an unrelated node
  // does not hand consumers a new context object.
  const stable = useRef(ctx)
  if (!sameContext(stable.current, ctx)) {
    stable.current = ctx
  }
  return stable.current as ResolvedContext<V> | null
}

function handlesOfType(type: string): ExtensionHandle[] {
  return extensionRegistry.resolveNode(type)?.handles ?? []
}

/**
 * The primitive or enum target handle `targetHandleId` of `node` as declared,
 * with its own id (a dynamic handle's id on the node), an enum's with its
 * cases, or undefined when the node has no such input of that id. Read from
 * the node's handles as `declaredHandlesOf` gives them, so a subgraph's input
 * ports and the inputs a value node derives from its data take typed values
 * too; it reads only the node, not the graph.
 */
export function valueHandleOf(
  node: { type?: string; data?: unknown } | undefined,
  targetHandleId: string,
): ValueHandle | undefined {
  const handle = node
    ? findExtensionHandle(
        declaredHandlesOf(node, handlesOfType, extensionRegistry.enumCasesOf),
        targetHandleId,
        'target',
      )
    : undefined
  return handle && (isPrimitiveType(handle.handleType) || isEnumHandle(handle))
    ? { ...handle, id: targetHandleId }
    : undefined
}

/**
 * `nodeId`'s data with its wired inputs as the open canvas has them, or
 * undefined when it is not on the canvas: what a card reads to show what the
 * node computes now (see `liveNodeData`).
 */
export function useLiveNodeData(nodeId: string): Record<string, unknown> | undefined {
  const graph = useCanvasGraph()
  const node = graph.nodes.find((n) => n.id === nodeId)
  return node ? liveNodeData(node, graph) : undefined
}

/** A primitive input of a node on the open canvas: how it is declared, whether an edge feeds it, and what it reads. */
export interface ValueInputState {
  handle: ValueHandle
  wired: boolean
  value: PrimitiveValue | undefined
}

/** The primitive input `targetHandleId` of `nodeId`, or undefined when the node declares none of that id. */
export function useValueInput(nodeId: string, targetHandleId: string): ValueInputState | undefined {
  const graph = useCanvasGraph()
  const node = graph.nodes.find((n) => n.id === nodeId)
  const handle = valueHandleOf(node, targetHandleId)
  if (!handle) {
    return undefined
  }
  const { wired, ctx } = wiredInput(graph, nodeId, targetHandleId)
  // `valueHandleOf` gives primitive and enum inputs only, which read primitives.
  const value = inputValue(node?.data, handle, wired ? (ctx ? { value: ctx.value } : null) : undefined)
  return { handle, wired, value: isPrimitiveValue(value) ? value : undefined }
}

/** See `useInputValue` in `@opencroft/client/canvas`. */
export function useInputValue(nodeId: string, targetHandleId: string): PrimitiveValue | undefined {
  return useValueInput(nodeId, targetHandleId)?.value
}
