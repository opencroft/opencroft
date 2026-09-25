'use client'

import { type ReactNode, useMemo } from 'react'
import { type ToolViewHost, ToolViewHostProvider } from 'ui/tool-views/tool-view-host'

import { readRemoteFile } from '@/app/_authed/(approvals)/_server/actions'
import { useCanvasNodes } from '@/app/_authed/(dashboard)/_canvas/canvas-nodes-context'
import { useOptionalOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { backgroundRunLabel } from '@/app/_authed/(mcp)/_server/execution-mode'
import { sseEventsStore } from '@/app/_authed/(sse)/_lib/sse-events-store'
import { CodeEditor, languageFromPath } from '@/components/code-editor'

// This app's side of the tool views' host contract. The views live in the kit
// and read everything product-specific through `useToolViewHost()`; this is the
// one place that answers them from the canvas, the overlay, the server and the
// editor this app actually has.
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

// @xyflow/react's `useKeyPress` calls `preventDefault()` on the keys it watches
// unless the event came from an element its `isInputDOMNode` recognises, a
// `.nokey` ancestor among them. Monaco takes input through the EditContext API
// on a plain div, so a caret inside a diff would send Backspace to the canvas
// as node deletion. The editor sets `nokey` on its own root as well; the class
// is kept here because it is the contract the canvas reads, and these diffs
// render inside the canvas whatever the editor does internally.
//
// With no language given, the language comes from `path`, and anything that is
// not a recognisable file name lands on `plaintext`: these diffs carry file
// contents, node property values and skill bodies, and highlighting all of that
// as the editor's default TypeScript is worse than not highlighting it.
function CanvasSafeDiffEditor({
  original,
  value,
  language,
  path,
}: {
  original: string
  value: string
  language?: string
  path?: string
}) {
  return (
    <div className='nokey'>
      <CodeEditor original={original} value={value} language={language ?? languageFromPath(path)} />
    </div>
  )
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
      DiffEditor: CanvasSafeDiffEditor,
      ApprovalPanel: OverlayApprovalPanel,
    }),
    [canvasNodes],
  )
  return <ToolViewHostProvider host={host}>{children}</ToolViewHostProvider>
}
