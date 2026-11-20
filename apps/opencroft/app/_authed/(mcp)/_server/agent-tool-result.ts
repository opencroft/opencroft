/**
 * The content-list form of an agent-tool handler's `body`: `{ content: [...] }`
 * and no other key, MCP's own tool result, handed to the agent so a picture
 * reaches the model as a picture: as it is, but for a picture too large for a
 * model, which is fitted the way remote_view_image fits one. Every other body
 * is answered as text by `executeAgentTool` (tools.ts).
 *
 * A content list is checked before it is handed over, because a malformed one
 * fails where nobody reads it: an image whose bytes are not what its
 * `mimeType` says is refused by the model provider, after the call has
 * "succeeded". Each refusal names the item and what is wrong with it.
 */

import { VISION_MIME_TYPES, type VisionMimeType } from '@/app/_authed/(agent)/_lib/vision-image'
import { prepareImage, sniffImageType } from '@/app/_authed/(mcp)/_server/remote-image'

const ITEM_TYPES = ['text', 'image'] as const

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Base64 characters that decode to the bytes `sniffImageType` reads, and some to spare. */
const SNIFF_CHARS = 64

/**
 * Whether `body` asks to be a content list: an object whose one own key is a
 * `content` array. Only that shape — a data object that also carries other
 * keys, `{ content: [...], total: 3 }`, stays data and is answered as JSON.
 * Whether its items are valid is a separate question (`itemProblem`).
 */
function isContentList(body: unknown): body is { content: unknown[] } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return false
  }
  const keys = Object.keys(body)
  return keys.length === 1 && keys[0] === 'content' && Array.isArray((body as { content: unknown }).content)
}

function isVisionMimeType(value: unknown): value is VisionMimeType {
  return typeof value === 'string' && (VISION_MIME_TYPES as readonly string[]).includes(value)
}

/** Why the item at `index` can't be handed to the agent, or undefined when it can. */
function itemProblem(item: unknown, index: number): string | undefined {
  const at = `content[${index}]`
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return `${at} is not an object`
  }
  const { type } = item as { type?: unknown }
  if (type === 'text') {
    const { text } = item as { text?: unknown }
    return typeof text === 'string' ? undefined : `${at} is a text item without a string "text"`
  }
  if (type === 'image') {
    const { data, mimeType } = item as { data?: unknown; mimeType?: unknown }
    if (!isVisionMimeType(mimeType)) {
      return `${at} is an image with mimeType ${JSON.stringify(mimeType)}; an image is one of ${VISION_MIME_TYPES.join(', ')}`
    }
    if (typeof data !== 'string' || !BASE64.test(data)) {
      return `${at} is an image whose "data" is not base64`
    }
    const sniffed = sniffImageType(Buffer.from(data.slice(0, SNIFF_CHARS), 'base64'))
    if (sniffed !== mimeType) {
      return `${at} says ${mimeType}, but its data is ${sniffed ?? 'not an image of a type a model takes'}`
    }
    return undefined
  }
  return `${at} has type ${JSON.stringify(type)}; a content list holds ${ITEM_TYPES.map((t) => `"${t}"`).join(' and ')} items`
}

interface ImageItem {
  type: 'image'
  data: string
  mimeType: VisionMimeType
}

/**
 * An image item as the model is sent it, the way remote_view_image sends a
 * file: unchanged when it is within the long edge and the size budget, and
 * otherwise scaled and re-encoded by `prepareImage` (vision-image.ts has the
 * bounds). The item's other keys are kept.
 */
async function fitImage(item: ImageItem, index: number): Promise<ImageItem> {
  let prepared: Awaited<ReturnType<typeof prepareImage>>
  try {
    prepared = await prepareImage(Buffer.from(item.data, 'base64'), item.mimeType, `content[${index}]`)
  } catch (err) {
    throw new Error(
      `the handler returned a content list that can't be handed over: ${(err as { message?: string }).message ?? String(err)}`,
    )
  }
  if (!prepared.reencoded) {
    return item
  }
  return { ...item, data: prepared.data.toString('base64'), mimeType: prepared.mimeType }
}

/**
 * The tool result for a handler's `body` when it is a content list, or
 * undefined when it is not one. Throws, naming every malformed item, when it is
 * a content list that can't be handed over.
 */
export async function contentListResult(body: unknown): Promise<Record<string, unknown> | undefined> {
  if (!isContentList(body)) {
    return undefined
  }
  const problems = body.content.flatMap((item, index) => itemProblem(item, index) ?? [])
  if (problems.length > 0) {
    throw new Error(`the handler returned a content list that can't be handed over: ${problems.join('; ')}.`)
  }
  const content = await Promise.all(
    body.content.map((item, index) =>
      (item as { type: string }).type === 'image' ? fitImage(item as ImageItem, index) : item,
    ),
  )
  return { content }
}
