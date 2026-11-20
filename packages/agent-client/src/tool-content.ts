// What a tool call returned, kept: the pictures, sounds, files and links in a
// result, as the transcript's `ToolContent` (see types.ts), next to the text
// the result is also flattened to.
//
// A result reaches the client in one of two places. An ACP harness reports it
// in the update's `content`, each block wrapped as `{ type: 'content' }` beside
// its `diff` and `terminal` entries. A host's in-process harness hands over the
// tool's own MCP envelope as `rawOutput` (`{ content: [...] }`). Both carry the
// same content blocks, which is what makes one reading serve both.
//
// The bytes of a picture or a sound are handed to the host's store before the
// update is folded (`toolMedia` lists them, in order) and come back as ids.
// `toolContent` places each answer at the block it came from, by that same
// order, so the two must walk the blocks identically: both go through
// `mediaOf`.

import type { ToolCallContent } from '@agentclientprotocol/sdk'

import { base64Bytes } from './tool-images'
import type { ToolContent } from './types'

/** A picture or a sound in a tool result, as the host's store is handed it. */
export interface ToolMedia {
  mimeType: string
  /** Base64 with no `data:` prefix, as the content block carries it. */
  data: string
}

/** What the host's store answers for one piece of media it kept. */
export interface StoredToolMedia {
  id: string
  width?: number
  height?: number
}

type Block = Record<string, unknown>

const isBlock = (value: unknown): value is Block => typeof value === 'object' && value !== null

// The blocks of a result, in order: the update's own `content` when it has
// any, else the MCP envelope a host's harness passes as `rawOutput`. Null for
// a result that is neither.
function resultBlocks(content: readonly ToolCallContent[] | null | undefined, rawOutput: unknown): Block[] | null {
  if (content && content.length > 0) {
    return content.map((entry) => (entry.type === 'content' ? (entry.content as Block) : (entry as Block)))
  }
  if (isBlock(rawOutput) && Array.isArray(rawOutput.content)) {
    return rawOutput.content.filter(isBlock)
  }
  return null
}

const MEDIA_KINDS = ['image', 'audio'] as const
type MediaKind = (typeof MEDIA_KINDS)[number]

function mediaKindOf(mimeType: string): MediaKind | null {
  const top = mimeType.split('/')[0]?.toLowerCase()
  return MEDIA_KINDS.find((kind) => kind === top) ?? null
}

// The picture or sound a block carries, or null. An embedded resource whose
// blob is a picture or a sound is one too: what draws it is its type, not
// the envelope it arrived in.
function mediaOf(block: Block): (ToolMedia & { kind: MediaKind }) | null {
  if ((block.type === 'image' || block.type === 'audio') && typeof block.data === 'string') {
    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : ''
    return { kind: block.type, mimeType, data: block.data }
  }
  if (block.type === 'resource' && isBlock(block.resource)) {
    const { blob, mimeType } = block.resource
    const kind = typeof mimeType === 'string' ? mediaKindOf(mimeType) : null
    if (kind && typeof blob === 'string') {
      return { kind, mimeType: mimeType as string, data: blob }
    }
  }
  return null
}

/**
 * The pictures and sounds in a tool result, in the order the result holds
 * them: what the host's store is asked to keep before the result is folded.
 */
export function toolMedia(content: readonly ToolCallContent[] | null | undefined, rawOutput: unknown): ToolMedia[] {
  return (resultBlocks(content, rawOutput) ?? []).flatMap((block) => {
    const media = mediaOf(block)
    return media ? [{ mimeType: media.mimeType, data: media.data }] : []
  })
}

const optional = <K extends string, V>(key: K, value: V | undefined | null) =>
  (value === undefined || value === null ? {} : { [key]: value }) as Partial<Record<K, V>>

function resourcePart(resource: Block): ToolContent {
  const uri = typeof resource.uri === 'string' ? resource.uri : ''
  const mimeType = typeof resource.mimeType === 'string' ? resource.mimeType : undefined
  if (typeof resource.text === 'string') {
    return { type: 'resource', uri, ...optional('mimeType', mimeType), text: resource.text }
  }
  const blob = typeof resource.blob === 'string' ? resource.blob : ''
  return { type: 'resource', uri, ...optional('mimeType', mimeType), byteSize: base64Bytes(blob) }
}

/**
 * A tool result as the transcript keeps it, or undefined when it holds
 * nothing but text and file changes: such a result is drawn from its text.
 * `stored` is the host's answer for each piece of
 * `toolMedia`, by position; a missing or null entry was not kept.
 */
export function toolContent(
  content: readonly ToolCallContent[] | null | undefined,
  rawOutput: unknown,
  stored: readonly (StoredToolMedia | null)[] = [],
): ToolContent[] | undefined {
  const blocks = resultBlocks(content, rawOutput)
  if (!blocks) {
    return undefined
  }
  let mediaIndex = 0
  const parts = blocks.flatMap((block): ToolContent[] => {
    const media = mediaOf(block)
    if (media) {
      const kept = stored[mediaIndex++]
      return [
        {
          type: media.kind,
          mimeType: media.mimeType,
          byteSize: base64Bytes(media.data),
          ...(kept ? { mediaId: kept.id, ...optional('width', kept.width), ...optional('height', kept.height) } : {}),
        },
      ]
    }
    switch (block.type) {
      case 'text':
        return typeof block.text === 'string' ? [{ type: 'text', text: block.text }] : []
      case 'resource_link':
        return [
          {
            type: 'resource_link',
            uri: typeof block.uri === 'string' ? block.uri : '',
            name: typeof block.name === 'string' ? block.name : '',
            ...optional('title', typeof block.title === 'string' ? block.title : undefined),
            ...optional('mimeType', typeof block.mimeType === 'string' ? block.mimeType : undefined),
            ...optional('byteSize', typeof block.size === 'number' ? block.size : undefined),
          },
        ]
      case 'resource':
        return isBlock(block.resource) ? [resourcePart(block.resource)] : []
      case 'terminal':
        return typeof block.terminalId === 'string' ? [{ type: 'terminal', terminalId: block.terminalId }] : []
      default:
        // `diff` travels as the event's `diffs`; a kind this client does not
        // know has nothing it could be drawn as.
        return []
    }
  })
  return parts.some((part) => part.type !== 'text') ? parts : undefined
}
