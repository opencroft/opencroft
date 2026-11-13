'use client'

// What a node's card writes: a value typed into one of its inputs (see
// `InlineValue`), and its own settings edited in place (a template, an
// expression, a list of cases), written the way the inspector writes them.

import type { PrimitiveValue } from '@opencroft/core/values'
import { createContext, type ReactNode, useCallback, useContext } from 'react'

import { TypedInputWriterContext } from '@/app/_authed/(extension-runtime)/_client/inline-value'

type NodeDataWriter = (nodeId: string, patch: Record<string, unknown>) => void

/** Merges a patch into a node's data, one undo step per field; the canvas provides it. Without a canvas nothing is written. */
const NodeDataWriterContext = createContext<NodeDataWriter | null>(null)

/** The canvas's writers of node data, for the cards drawn inside it. */
export function CanvasWriters({
  typedInput,
  nodeData,
  children,
}: {
  typedInput: (nodeId: string, handleId: string, value: PrimitiveValue) => void
  nodeData: NodeDataWriter
  children: ReactNode
}) {
  return (
    <TypedInputWriterContext.Provider value={typedInput}>
      <NodeDataWriterContext.Provider value={nodeData}>{children}</NodeDataWriterContext.Provider>
    </TypedInputWriterContext.Provider>
  )
}

/** See `useUpdateNodeData` in `@opencroft/client/canvas`. */
export function useUpdateNodeData(nodeId: string): (patch: Record<string, unknown>) => void {
  const write = useContext(NodeDataWriterContext)
  return useCallback((patch: Record<string, unknown>) => write?.(nodeId, patch), [write, nodeId])
}
