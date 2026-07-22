import type { ChatMessage } from 'agent-client/fold'
import type { ComponentType, ReactNode } from 'react'

export type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>

// How a registered custom tool view sits relative to the default tool-call card:
//  - 'replace': show the custom view instead of the tool call
//  - 'before' : show the custom view above the tool call
//  - 'after'  : show the custom view below the tool call
export type ToolViewDisplay = 'replace' | 'before' | 'after'

// Which side of the call a view is rendering for: 'approval' is a pending
// request awaiting a permission decision (no result yet — a host's approval
// UI is the only current consumer, not the chat transcript itself); 'history'
// is a call the transcript is displaying, settled or still running.
export type ToolViewMode = 'approval' | 'history'

export interface ToolViewResult {
  // The same formatted/status pair the default tool-call chrome shows, for
  // views that just want to display it without reformatting `output` themselves.
  text: string
  isError?: boolean
  // Raw value from the tool call's output/result — present once the call has
  // produced one. Views that need structure (e.g. pulling a URL out of an
  // object result) should read this instead of `text`. Optional (rather than
  // always-present) so a view typed against a narrower, output-less result
  // shape — e.g. one built for a host with its own `{text, isError}`-only
  // convention — stays a valid ToolViewSpec.component without changes.
  output?: unknown
}

export interface ToolViewProps {
  tool: string
  args: Record<string, unknown>
  requestId: string
  mode: ToolViewMode
  // Undefined for a call that hasn't produced output yet.
  result?: ToolViewResult
}

export interface ToolViewSpec {
  display: ToolViewDisplay
  component: ComponentType<ToolViewProps>
  // Pre-render check for callers that need to know whether this view has
  // something to show WITHOUT rendering it — e.g. deciding whether a tool
  // message stays visible when the "Tools" toggle hides plain calls. Defaults
  // to true (most registered views always show something); provide this only
  // for a view that can be a no-op until its data arrives (e.g. an image view
  // with no URL yet).
  hasContent?: (props: ToolViewProps) => boolean
}

// A registry of custom tool views keyed by tool name (the tool_call title).
// Pass one to <ChatView toolViews={...}> to render rich output for specific
// tools (e.g. an image for an image-generation tool).
export type ToolViewRegistry = Record<string, ToolViewSpec>

// Some MCP clients (e.g. Claude Code) report tool names prefixed with the
// server they came from — `mcp__<server>__<tool>` — to disambiguate multiple
// connected servers. Registered ids are always the bare tool name, so strip
// that prefix before matching one. The tool call's own `tool`/`title` field
// (see toolViewProps below) is left untouched — a view still sees the full
// name it was actually called with, only registry lookup is normalized.
export function normalizeToolId(id: string): string {
  return id.replace(/^mcp__[\w-]+?__/, '')
}

// Resolve a registered view by tool name, normalizing an `mcp__<server>__`
// prefix first. Prefer this over indexing the registry directly.
export function lookupToolView(registry: ToolViewRegistry, toolId: string): ToolViewSpec | undefined {
  return registry[normalizeToolId(toolId)]
}

// Build the props a registered view (or a host's own lookup) needs from a
// folded tool message. Exported so hosts with their own rendering path (e.g.
// a standalone approval list, which never gets a ChatMessage) can still reuse
// the same prop shape by constructing it from whatever data they have.
export function toolViewProps(message: ToolMessage, mode: ToolViewMode): ToolViewProps {
  const settled = message.status === 'completed' || message.status === 'failed'
  const result: ToolViewResult | undefined =
    settled || message.output !== undefined
      ? { output: message.output, text: formatToolValue(message.output), isError: message.status === 'failed' }
      : undefined
  return {
    tool: message.title,
    args: (message.input ?? {}) as Record<string, unknown>,
    requestId: message.toolCallId,
    mode,
    result,
  }
}

export function formatToolValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// A tool message has renderable custom content when its registered view returns
// something. Such messages stay visible even when the "Tools" toggle hides
// plain tool calls.
export function hasToolView(message: ChatMessage, registry: ToolViewRegistry): boolean {
  if (message.kind !== 'tool') return false
  const spec = lookupToolView(registry, message.title)
  if (!spec) return false
  if (!spec.hasContent) return true
  return spec.hasContent(toolViewProps(message, 'history'))
}

// Pull a usable http(s) URL out of a tool result (a string, {url}/{text}, or an
// MCP-style { content: [{ text }] }). Exported so hosts can build their own
// media tool views.
export function extractUrl(output: unknown): string | null {
  let text: string | undefined
  if (typeof output === 'string') {
    text = output
  } else if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>
    if (typeof obj.url === 'string') text = obj.url
    else if (typeof obj.text === 'string') text = obj.text
    else if (Array.isArray(obj.content)) {
      const part = (obj.content as Array<Record<string, unknown>>).find((entry) => typeof entry.text === 'string')
      text = part?.text as string | undefined
    }
  }
  text = text?.trim()
  // Accept absolute URLs and relative paths (served by the host's media proxy).
  return text && (/^https?:\/\//.test(text) || text.startsWith('/')) ? text : null
}

function ImageToolView({ args, result }: ToolViewProps): ReactNode {
  const url = extractUrl(result?.output)
  if (!url) return null
  const prompt = (args as { prompt?: unknown }).prompt
  return (
    <a href={url} target='_blank' rel='noreferrer' className='block w-full overflow-hidden'>
      <img
        src={url}
        alt={typeof prompt === 'string' ? prompt : 'Generated image'}
        decoding='async'
        className='w-full max-w-full rounded-lg border shadow-sm'
      />
    </a>
  )
}

// A ready-made view that renders a tool's URL result as an inline image. Register
// it under the relevant tool name, e.g. `{ generate_image: imageToolView }`.
export const imageToolView: ToolViewSpec = {
  display: 'replace',
  component: ImageToolView,
  hasContent: ({ result }) => extractUrl(result?.output) !== null,
}
