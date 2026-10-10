// A LocalTool.handler may return either a plain string (the original,
// simplest contract) or a full MCP content envelope (`{ content: [...],
// isError?: true }` — the shape a host's own tool dispatcher might already
// return). These helpers let both agent-client hosts (the ACP-facing
// mcp-server.ts and the in-process native-harness.ts) accept either shape
// without each reimplementing the distinction.

export type ToolResult = string | Record<string, unknown>

interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

function blockText(block: unknown): string {
  const b = block as ContentBlock
  if (b && b.type === 'text' && typeof b.text === 'string') {
    return b.text
  }
  // A string-only host cannot hand a picture to its model, and the block's
  // base64 as text is megabytes of noise in the model's context. Say what was
  // there instead.
  if (b && (b.type === 'image' || b.type === 'audio') && typeof b.data === 'string') {
    const label = typeof b.mimeType === 'string' ? `${b.type} ${b.mimeType}` : b.type
    return `[${label}, not shown: this harness passes tool results as text only]`
  }
  return JSON.stringify(block)
}

// Flatten a ToolResult down to plain text — for hosts (the native harness'
// AI SDK toolset) that only understand string tool output.
export function flattenToolResult(result: ToolResult): string {
  if (typeof result === 'string') {
    return result
  }
  const content = result.content
  return Array.isArray(content) ? content.map(blockText).join('\n') : JSON.stringify(result)
}

// Normalize a ToolResult into an MCP CallToolResult — for hosts (the ACP
// mcp-server) that need the full envelope. A plain string is wrapped; an
// already-structured envelope passes through unchanged.
export function toCallToolResult(result: ToolResult): Record<string, unknown> {
  return typeof result === 'string' ? { content: [{ type: 'text' as const, text: result }] } : result
}
