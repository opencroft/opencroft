'use client'

import { useReactFlow } from '@xyflow/react'
import { createContext, type ReactNode, useContext, useMemo } from 'react'

// The whole of what tool views need from a canvas: resolve a node id to that
// node, so a call's target can be shown by name instead of by raw id.
//
// It exists as its own context because a tool view is rendered by the chat
// surface, and the chat surface is not only mounted on the canvas — a
// standalone chat route has no canvas at all. Calling `useReactFlow()` inside
// a tool view made every one of them un-renderable there: the hook throws
// when its provider is missing, and one throw takes down the whole route.
//
// So the capability is injected by the host that actually has a canvas, and
// its absence is a value (`null`) rather than an exception. Tool views degrade
// to the plain node id; nothing crashes.

export interface CanvasNode {
  data?: Record<string, unknown>
  position?: { x: number; y: number }
}

export interface CanvasNodes {
  getNode: (nodeId: string) => CanvasNode | undefined
}

const CanvasNodesContext = createContext<CanvasNodes | null>(null)

/**
 * Publishes the canvas's node lookup to everything below it.
 *
 * Mount inside a `ReactFlowProvider` — this is deliberately the only place
 * `useReactFlow` is called on a tool view's behalf, which is what keeps the
 * tool views renderable on surfaces that have no canvas.
 */
export function CanvasNodesProvider({ children }: { children: ReactNode }) {
  const { getNode } = useReactFlow()
  const value = useMemo<CanvasNodes>(
    () => ({ getNode: (nodeId: string) => getNode(nodeId) as CanvasNode | undefined }),
    [getNode],
  )
  return <CanvasNodesContext.Provider value={value}>{children}</CanvasNodesContext.Provider>
}

/**
 * The canvas node lookup, or `null` where there is no canvas.
 *
 * Never throws. A caller that gets `null` has no canvas to point at and should
 * render whatever it can from the id alone — not a control that would look
 * live and do nothing.
 */
export function useCanvasNodes(): CanvasNodes | null {
  return useContext(CanvasNodesContext)
}
