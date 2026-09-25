'use client'

import { type ComponentType, createContext, type ReactNode, useContext } from 'react'

// A node as a tool view reads it: its data (the name under `data.name`, and
// any property a view diffs, read by dotted path) and where it sits.
export interface ToolViewNode {
  data?: Record<string, unknown>
  position?: { x: number; y: number }
}

// Everything a tool view needs from the product it runs in. One interface for
// every view, so a host wires it once and a view added later cannot reach past
// it for a canvas, an overlay or a store of its own.
//
// No member is a hook. A view calls functions and renders components, so what a
// host passes here cannot break the rules of hooks inside a view.
export interface ToolViewHost {
  // The current contents of a file on a remote target. A rejection's message is
  // shown to the reader as the reason the diff is missing.
  readFile: (request: { target: string; space?: string; path: string }) => Promise<string>
  // The current body of a skill, or '' when there is no skill by that name.
  readSkill: (name: string) => Promise<string>
  // How a call that runs in the background reads to the person approving it, or
  // undefined for one that runs in place. The host words it, because the limit
  // it states has to be the one the service enforces rather than a copy.
  describeBackgroundRun: (args: Record<string, unknown>) => string | undefined
  // Present only where a canvas is mounted. Both halves hang off that one fact:
  // with no canvas, names fall back to ids and a target is plain text rather
  // than a button that would look live and do nothing.
  canvas?: {
    getNode: (nodeId: string) => ToolViewNode | undefined
    focusNode: (nodeId: string) => void
  }
  // The diff editor. `language` when the view knows it; otherwise `path`, for
  // the host to infer the language from.
  DiffEditor: ComponentType<{ original: string; value: string; language?: string; path?: string }>
  // Where an approval-mode diff is shown larger than the approval list allows.
  // Renders nothing itself. Absent, the content is simply not projected.
  ApprovalPanel?: ComponentType<{ children: ReactNode }>
}

const ToolViewHostContext = createContext<ToolViewHost | null>(null)

export function ToolViewHostProvider({ host, children }: { host: ToolViewHost; children: ReactNode }) {
  return <ToolViewHostContext.Provider value={host}>{children}</ToolViewHostContext.Provider>
}

// Throws rather than falling back to inert defaults: a view with no host would
// otherwise render a diff with nothing on one side and look finished. The throw
// is meant to be contained by an error boundary around each view.
export function useToolViewHost(): ToolViewHost {
  const host = useContext(ToolViewHostContext)
  if (!host) {
    throw new Error('A tool view was rendered outside <ToolViewHostProvider>. Mount the host provider around it.')
  }
  return host
}
