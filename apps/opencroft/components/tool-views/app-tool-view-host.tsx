'use client'

import { type ReactNode, useMemo } from 'react'
import { type ToolViewHost, ToolViewHostProvider } from 'ui/tool-views/tool-view-host'

import { readRemoteFile } from '@/app/_authed/(approvals)/_server/actions'
import { useCanvasNodes } from '@/app/_authed/(dashboard)/_canvas/canvas-nodes-context'
import { useOptionalOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { backgroundRunLabel } from '@/app/_authed/(mcp)/_server/execution-mode'
import { sseEventsStore } from '@/app/_authed/(sse)/_lib/sse-events-store'

// This app's side of the tool views' host contract. The views live in the kit
// and read everything product-specific through `useToolViewHost()`; this is the
// one place that answers them from the canvas, the overlay and the server this
// app actually has.
//
// Mount it inside the RenderBoundary around each view, not above it. It reads
// the canvas and overlay context at the same tree position the views used to
// read it themselves, so an embedded chat still sees the canvas it sits in; and
// if a view is ever rendered without it, the throw from `useToolViewHost()` is
// contained by that same boundary rather than taking the route down.

async function readSkill(name: string): Promise<string> {
  const response = await fetch('/api/acp/skills')
  const skills: { name: string; body: string }[] = await response.json()
  return skills.find((skill) => skill.name === name)?.body ?? ''
}

function readFile({ target, space, path }: { target: string; space?: string; path: string }): Promise<string> {
  return readRemoteFile({ data: { target, space, path } })
}

// Projects an approval-mode diff into the canvas overlay's content slot. Where
// no overlay is mounted, `useOptionalOverlay` discards the write, which is what
// the views did before they had a host. Module-level so its identity is stable:
// a new component per render would remount it and clear the slot every time.
function OverlayApprovalPanel({ children }: { children: ReactNode }) {
  useOptionalOverlay({ content: children })
  return null
}

function focusNode(nodeId: string) {
  sseEventsStore.dispatch({ type: 'focus_node', nodeId, panToNode: true })
}

export function AppToolViewHost({ children }: { children: ReactNode }) {
  const canvasNodes = useCanvasNodes()
  const host = useMemo<ToolViewHost>(
    () => ({
      readFile,
      readSkill,
      describeBackgroundRun: backgroundRunLabel,
      canvas: canvasNodes ? { getNode: canvasNodes.getNode, focusNode } : undefined,
      ApprovalPanel: OverlayApprovalPanel,
    }),
    [canvasNodes],
  )
  return <ToolViewHostProvider host={host}>{children}</ToolViewHostProvider>
}
