'use client'

import type { ComponentType } from 'react'

// A rich, tool-specific view of an MCP tool call — shared by the approval
// prompt (before the call runs) and the agent chat transcript (after it ran).
// `mode` tells a view which side of the call it's rendering: 'approval' has
// live pre-call state to diff against args; 'history' only has post-call live
// state, so a view that wants a diff must reconstruct the "before" side from
// args instead (see the substitution-based views in builtin-views.tsx).
export interface ToolViewProps {
  tool: string
  args: Record<string, unknown>
  requestId: string
  mode: 'approval' | 'history'
  // The call's result — only ever present in 'history' mode (an approval
  // request precedes execution, so there's nothing to show yet).
  result?: { text: string; isError?: boolean }
}

export interface ToolViewSpec {
  body: ComponentType<ToolViewProps>
  getNodeId?: (args: Record<string, unknown>) => string | undefined
}

function formatArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, null, 2)
}

export function DefaultToolView({ args }: ToolViewProps) {
  return (
    <div className='space-y-1 px-3 py-2'>
      <div className='text-xs font-medium text-muted-foreground'>Arguments</div>
      <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-72 overflow-auto font-mono'>
        {formatArgs(args)}
      </pre>
    </div>
  )
}

const DEFAULT_SPEC: ToolViewSpec = { body: DefaultToolView }

const registry = new Map<string, ToolViewSpec>()

export function registerToolView(id: string, spec: ToolViewSpec): void {
  registry.set(id, spec)
}

// Some MCP clients (e.g. Claude Code) report tool names prefixed with the
// server they came from — `mcp__<server>__<tool>` — to disambiguate multiple
// connected servers. Registered ids are always the bare tool name, so strip
// that prefix before matching.
function normalizeToolId(id: string): string {
  return id.replace(/^mcp__[\w-]+__/, '')
}

// Always returns a spec, falling back to a raw-args dump — for callers (the
// approval prompt) that must render something regardless of whether a rich
// view is registered.
export function resolveToolView(id?: string): ToolViewSpec {
  if (!id) {
    return DEFAULT_SPEC
  }
  return registry.get(normalizeToolId(id)) ?? DEFAULT_SPEC
}

// Only a specifically registered view, or undefined — for callers (the chat
// transcript) that already have a reasonable default of their own to fall
// back to instead of the raw-args dump.
export function lookupToolView(id: string): ToolViewSpec | undefined {
  return registry.get(normalizeToolId(id))
}
