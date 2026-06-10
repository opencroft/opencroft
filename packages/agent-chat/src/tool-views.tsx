import type { ChatMessage } from 'agent-client/fold'
import type { ReactNode } from 'react'

export type ToolMessage = Extract<ChatMessage, { kind: 'tool' }>

// How a registered custom tool view sits relative to the default tool-call card:
//  - 'replace': show the custom view instead of the tool call
//  - 'before' : show the custom view above the tool call
//  - 'after'  : show the custom view below the tool call
// `render` returns null when it can't render yet (e.g. the output hasn't arrived),
// in which case the default tool call is shown regardless of `display`.
export type ToolViewDisplay = 'replace' | 'before' | 'after'

export interface ToolViewDef {
  display: ToolViewDisplay
  render: (message: ToolMessage) => ReactNode
}

// A registry of custom tool views keyed by tool name (the tool_call title).
// Pass one to <ChatView toolViews={...}> to render rich output for specific
// tools (e.g. an image for an image-generation tool).
export type ToolViewRegistry = Record<string, ToolViewDef>

// A tool message has renderable custom content when its registered view returns
// a node. Such messages stay visible even when the "Tools" toggle hides plain
// tool calls.
export function hasToolView(message: ChatMessage, registry: ToolViewRegistry): boolean {
  return message.kind === 'tool' && (registry[message.title]?.render(message) ?? null) !== null
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

// A ready-made view that renders a tool's URL result as an inline image. Register
// it under the relevant tool name, e.g. `{ generate_image: imageToolView }`.
export const imageToolView: ToolViewDef = {
  display: 'replace',
  render: (message) => {
    const url = extractUrl(message.output)
    if (!url) return null
    const prompt = (message.input as { prompt?: unknown } | undefined)?.prompt
    return (
      <a href={url} target='_blank' rel='noreferrer' className='block w-full overflow-hidden'>
        <img src={url} alt={typeof prompt === 'string' ? prompt : 'Generated image'} decoding='async' className='w-full max-w-full rounded-lg border shadow-sm' />
      </a>
    )
  },
}
