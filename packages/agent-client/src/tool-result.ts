// A LocalTool.handler may return either a plain string (the original,
// simplest contract) or a full MCP content envelope (`{ content: [...],
// isError?: true }` — the shape a host's own tool dispatcher might already
// return). These helpers let both agent-client hosts (the ACP-facing
// mcp-server.ts and the in-process native-harness.ts) accept either shape
// without each reimplementing the distinction.

import type { ToolContent } from 'ai'

export type ToolResult = string | Record<string, unknown>

/** A tool result as the AI SDK gives it to a model (`ToolResultPart['output']`). */
export type ToolOutput = Extract<ToolContent[number], { type: 'tool-result' }>['output']

interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

interface ImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

function isImageBlock(block: unknown): block is ImageBlock {
  const b = block as ContentBlock
  return Boolean(b) && b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string'
}

function blockText(block: unknown): string {
  const b = block as ContentBlock
  if (b && b.type === 'text' && typeof b.text === 'string') {
    return b.text
  }
  // A picture or a sound that reaches here is not handed to the model as one:
  // a block in a text answer (an error's text, or audio, which the model is
  // never sent). Its base64 as text is megabytes of noise in the model's
  // context, so say what was there instead.
  if (b && (b.type === 'image' || b.type === 'audio') && typeof b.data === 'string') {
    const label = typeof b.mimeType === 'string' ? `${b.type} ${b.mimeType}` : b.type
    return `[${label}, not shown to the model]`
  }
  return JSON.stringify(block)
}

function contentBlocks(result: ToolResult): unknown[] | undefined {
  if (typeof result === 'string') {
    return undefined
  }
  return Array.isArray(result.content) ? result.content : undefined
}

// Flatten a ToolResult down to plain text — for a tool answer the model is
// given as text: one without pictures, and an error result, whose text the
// native harness throws.
export function flattenToolResult(result: ToolResult): string {
  if (typeof result === 'string') {
    return result
  }
  const content = contentBlocks(result)
  return content ? content.map(blockText).join('\n') : JSON.stringify(result)
}

/**
 * What a tool call answers the in-process loop with: the flattened text when
 * the result holds no picture, so a text answer stays a plain string (in the
 * transcript, in the recorded log and to the model); the envelope
 * itself when it does, so the pictures reach `toolModelOutput` instead of
 * being flattened away.
 */
export function toolAnswer(result: ToolResult): ToolResult {
  return contentBlocks(result)?.some(isImageBlock) ? result : flattenToolResult(result)
}

/**
 * A tool's answer (see `toolAnswer`) as the model is given it, in the AI SDK's
 * provider-neutral shape: text as text, and an answer carrying pictures as
 * content parts with each picture in its place among the text. That shape is
 * what an API taking pictures inside a tool result (Responses, Anthropic
 * Messages) sends as it is; how Chat Completions, whose tool messages carry
 * text only, delivers them is decided when the request is built
 * (`tool-images.ts`).
 */
export function toolModelOutput(answer: ToolResult): ToolOutput {
  const content = contentBlocks(answer)
  if (typeof answer === 'string' || !content?.some(isImageBlock)) {
    return { type: 'text', value: flattenToolResult(answer) }
  }
  return {
    type: 'content',
    value: content.map((block) =>
      isImageBlock(block)
        ? { type: 'image-data' as const, data: block.data, mediaType: block.mimeType }
        : { type: 'text' as const, text: blockText(block) },
    ),
  }
}

// Normalize a ToolResult into an MCP CallToolResult — for hosts (the ACP
// mcp-server) that need the full envelope. A plain string is wrapped; an
// already-structured envelope passes through unchanged.
export function toCallToolResult(result: ToolResult): Record<string, unknown> {
  return typeof result === 'string' ? { content: [{ type: 'text' as const, text: result }] } : result
}
