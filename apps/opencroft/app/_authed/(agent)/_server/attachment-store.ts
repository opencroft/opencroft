// The bytes behind an image a reader attached to a message, and behind a
// picture or a sound a tool returned in the conversation.
//
// A message carries only a reference (see attachments.ts in agent-client), beside
// its text: the reference names a row here, and delivery turns that row into the
// ACP image block. A tool result in the transcript names a row the same way (its
// `mediaId`, see ToolContent in agent-client). So this is the one place the bytes
// exist, which makes their lifetime the whole design problem — a row nobody can reach is not a missing chip, it
// is bytes that never go away.
//
// FILED UNDER THE SESSION KEY, like the durable queue and the transcript beside
// it, and retired by the same two events: the key being dropped for good
// (acp-impl's delete path) and the key being re-minted by a rename
// (session-key-move). Cleared at those call sites rather than from inside
// clearSessionEvents, because that function is ALSO called on a failed replay,
// where the conversation lives on and its pictures must live with it.
//
// A tool's media goes sooner as well (releaseToolMedia): the agent has already
// looked at it, and once the conversation is compacted or its thread archived
// the transcript says what it was instead of showing it.

import { chatAttachment, db } from '@opencroft/db'
import type { AttachmentRef, PromptAttachment } from 'agent-client/attachments'
import { and, eq, inArray, lt } from 'drizzle-orm'
import sharp from 'sharp'

import { VISION_MIME_TYPES } from '@/app/_authed/(agent)/_lib/vision-image'

/** What a reader may attach: what a vision model is served (see VISION_MIME_TYPES). */
export const ATTACHABLE_MIME_TYPES = VISION_MIME_TYPES

/**
 * The hard ceiling on one stored image, in decoded bytes.
 *
 * A backstop, not the thing that decides quality: the composer re-encodes to a
 * vision model's own working size before it ever uploads (see attachment-file
 * in the chat), and this only refuses what arrived without that. Deliberately
 * well above what the composer produces, so a legitimate picture is never
 * rejected for being a little over — and well below what would make a thread's
 * rows expensive to read.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024

export interface StoredAttachment {
  id: string
  name: string
  mimeType: string
  byteSize: number
}

export class AttachmentRejected extends Error {}

/**
 * The size a picture displays at, read from its own header -- with a recorded
 * orientation applied, since a browser draws a rotated photo rotated. For an
 * animation, one frame. Null when the bytes do not say: the picture is still
 * stored, and a surface falls back to a box of its own.
 */
async function readDisplaySize(data: string): Promise<{ width: number; height: number } | null> {
  try {
    const { autoOrient } = await sharp(Buffer.from(data, 'base64')).metadata()
    return autoOrient.width > 0 && autoOrient.height > 0 ? autoOrient : null
  } catch {
    return null
  }
}

/**
 * Store one image and answer with what a composer needs to name it.
 *
 * The mime type is taken from the decoded payload's own declaration rather
 * than trusted from a file name: an extension is a reader's label, and what
 * decides whether a block may travel is what the bytes say they are.
 */
export async function saveAttachment(input: {
  sessionKey: string
  name: string
  mimeType: string
  /** Base64 with no `data:` prefix. */
  data: string
}): Promise<StoredAttachment> {
  const mimeType = input.mimeType.toLowerCase()
  if (!(ATTACHABLE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new AttachmentRejected(`${input.mimeType || 'that file type'} cannot be attached`)
  }
  const byteSize = decodedSize(input.data)
  if (byteSize === 0) {
    throw new AttachmentRejected('that image is empty')
  }
  if (byteSize > MAX_ATTACHMENT_BYTES) {
    // One decimal, not whole megabytes: rounded, a 4.2 MB picture read "4 MB,
    // over the 4 MB limit", which tells the reader nothing they can act on.
    const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
    throw new AttachmentRejected(`that image is ${mb(byteSize)} MB, over the ${mb(MAX_ATTACHMENT_BYTES)} MB limit`)
  }
  const name = input.name.trim() || 'image'
  const size = await readDisplaySize(input.data)
  const [row] = await db
    .insert(chatAttachment)
    .values({ sessionKey: input.sessionKey, name, mimeType, data: input.data, byteSize, ...size })
    .returning({ id: chatAttachment.id })
  return { id: row.id, name, mimeType, byteSize }
}

/**
 * What a tool's media may be kept as: the pictures a reader may attach, and a
 * fixed set of sounds. Kept means served back from this origin under the type
 * stored with it (attachmentResponse), and the type comes from whatever tool
 * answered. So the list is closed and holds no type a browser runs as a
 * document or a script: an SVG or an HTML page a tool returned is never
 * stored, and the transcript names it instead.
 */
export const TOOL_MEDIA_MIME_TYPES = [
  ...ATTACHABLE_MIME_TYPES,
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
] as const

/**
 * Keep a picture or a sound a tool returned in a conversation, as the engine's
 * `storeToolMedia` hook. Null for one that is not kept: a type outside
 * TOOL_MEDIA_MIME_TYPES, nothing at all, or over MAX_ATTACHMENT_BYTES, the
 * ceiling every row here shares (see loadAttachments for what a larger row
 * costs the database).
 */
export async function saveToolMedia(input: {
  sessionKey: string
  mimeType: string
  /** Base64 with no `data:` prefix. */
  data: string
}): Promise<{ id: string; width?: number; height?: number } | null> {
  const mimeType = input.mimeType.toLowerCase()
  const byteSize = decodedSize(input.data)
  const kept = (TOOL_MEDIA_MIME_TYPES as readonly string[]).includes(mimeType)
  if (!kept || byteSize === 0 || byteSize > MAX_ATTACHMENT_BYTES) {
    return null
  }
  const size = mimeType.startsWith('image/') ? await readDisplaySize(input.data) : null
  const [row] = await db
    .insert(chatAttachment)
    .values({
      sessionKey: input.sessionKey,
      name: mimeType,
      mimeType,
      data: input.data,
      byteSize,
      origin: 'tool',
      ...size,
    })
    .returning({ id: chatAttachment.id })
  return { id: row.id, ...(size ?? {}) }
}

/**
 * Let go of the media tools returned in a conversation: all of it, or only
 * what was stored before `before` (a compaction keeps what arrived after it).
 * A message's attachments stay; they keep the key's own lifetime.
 */
export async function releaseToolMedia(sessionKey: string, before?: Date): Promise<void> {
  await db
    .delete(chatAttachment)
    .where(
      and(
        eq(chatAttachment.sessionKey, sessionKey),
        eq(chatAttachment.origin, 'tool'),
        before ? lt(chatAttachment.createdAt, before) : undefined,
      ),
    )
}

// Base64 is four characters per three bytes, with the padding standing in for
// the bytes the last group does not have — so the size is known without
// decoding a payload that might be refused anyway.
function decodedSize(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/**
 * The references a send may carry, resolved from what the composer handed in.
 *
 * Ids only cross the wire; the name and type a message records are read here,
 * from the row, so a caller cannot label a picture as something it is not. And
 * every id must be a row of THIS conversation -- one that is not is refused
 * outright rather than dropped, since a send that quietly lost a picture is the
 * failure the whole feature is built against. And a row a reader attached: what
 * a tool returned is the transcript's, and a send cannot pass it off as the
 * reader's own by naming its id.
 */
export async function resolveAttachmentRefs(sessionKey: string, ids: readonly string[]): Promise<AttachmentRef[]> {
  if (ids.length === 0) {
    return []
  }
  const rows = await db
    .select({
      id: chatAttachment.id,
      name: chatAttachment.name,
      mimeType: chatAttachment.mimeType,
      width: chatAttachment.width,
      height: chatAttachment.height,
      sessionKey: chatAttachment.sessionKey,
    })
    .from(chatAttachment)
    .where(and(inArray(chatAttachment.id, [...ids]), eq(chatAttachment.origin, 'message')))
  const byId = new Map(rows.filter((row) => row.sessionKey === sessionKey).map((row) => [row.id, row]))
  return ids.map((id) => {
    const row = byId.get(id)
    if (!row) {
      throw new AttachmentRejected('an attached picture is not part of this conversation')
    }
    return {
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
    }
  })
}

/**
 * The attachments a delivery carries, as the engine's `loadAttachments` hook.
 *
 * Scoped to the session key: an id is not a capability, and a message naming
 * another conversation's row must resolve to nothing rather than to its bytes.
 * Missing ids are simply absent from the answer — the engine reports the
 * shortfall in the transcript, which is the one place a reader would look.
 *
 * ONE ROW PER QUERY, never `where id in (…)` over the data column. Each row is
 * up to MAX_ATTACHMENT_BYTES of image as base64, and the embedded PGlite
 * builds a whole result in its wasm memory: measured 01.10.2026, three ~4 MiB
 * rows in one query came back and four ran it out of memory ("memory access
 * out of bounds"), after which every query on that database failed until the
 * process restarted. One row at a time keeps any read at a single image
 * however many a message carries. The engine asks for one id per call anyway
 * (see promptBlocks in agent-client); this holds for any other caller too.
 */
export async function loadAttachments(sessionKey: string, ids: readonly string[]): Promise<PromptAttachment[]> {
  // In the order the MESSAGE named them, not the order a database might
  // answer in: the blocks travel in that order and a reader who attached two
  // pictures meant the first one first.
  const loaded: PromptAttachment[] = []
  for (const id of ids) {
    // A reader's attachments only: a message's text can be edited, and a tag
    // naming a tool's row must not make it travel as something the reader sent.
    const row = await readAttachment(sessionKey, id, 'message')
    if (row) {
      loaded.push({ id, ...row })
    }
  }
  return loaded
}

/**
 * The stored byte size of each of `ids` that is a row of this conversation.
 * Rows of any other conversation are absent from the answer, as they are from
 * every other read here.
 */
export async function readAttachmentSizes(sessionKey: string, ids: readonly string[]): Promise<Record<string, number>> {
  if (ids.length === 0) {
    return {}
  }
  const rows = await db
    .select({ id: chatAttachment.id, byteSize: chatAttachment.byteSize, sessionKey: chatAttachment.sessionKey })
    .from(chatAttachment)
    .where(inArray(chatAttachment.id, [...ids]))
  return Object.fromEntries(rows.filter((row) => row.sessionKey === sessionKey).map((row) => [row.id, row.byteSize]))
}

/**
 * One stored picture or sound -- for delivery (loadAttachments), and for a
 * surface that draws it, the transcript, through attachmentResponse. Another
 * conversation's id answers null, and so does one of another `origin` when
 * one is asked for.
 */
export async function readAttachment(
  sessionKey: string,
  id: string,
  origin?: 'message' | 'tool',
): Promise<{ name: string; mimeType: string; data: string } | null> {
  const [row] = await db
    .select({
      name: chatAttachment.name,
      mimeType: chatAttachment.mimeType,
      data: chatAttachment.data,
      sessionKey: chatAttachment.sessionKey,
      origin: chatAttachment.origin,
    })
    .from(chatAttachment)
    .where(eq(chatAttachment.id, id))
  const found = row && row.sessionKey === sessionKey && (!origin || row.origin === origin)
  return found ? { name: row.name, mimeType: row.mimeType, data: row.data } : null
}

/** Everything held for a key that is being retired for good. */
export async function clearAttachments(sessionKey: string): Promise<void> {
  await db.delete(chatAttachment).where(eq(chatAttachment.sessionKey, sessionKey))
}

/** Carry attachments onto a re-minted key, so a rename does not orphan them. */
export async function moveAttachments(moves: readonly { from: string; to: string }[]): Promise<void> {
  for (const { from, to } of moves) {
    if (!from || !to || from === to) {
      continue
    }
    await db.update(chatAttachment).set({ sessionKey: to }).where(eq(chatAttachment.sessionKey, from))
  }
}
