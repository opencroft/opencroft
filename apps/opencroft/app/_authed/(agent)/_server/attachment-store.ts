// The bytes behind an image a reader attached to a message.
//
// A message carries only a reference (see attachments.ts in agent-client), beside
// its text: the reference names a row here, and delivery turns that row into the
// ACP image block. So this is the one place the picture exists, which makes its lifetime
// the whole design problem — a row nobody can reach is not a missing chip, it
// is bytes that never go away.
//
// FILED UNDER THE SESSION KEY, like the durable queue and the transcript beside
// it, and retired by the same two events: the key being dropped for good
// (acp-impl's delete path) and the key being re-minted by a rename
// (session-key-move). Cleared at those call sites rather than from inside
// clearSessionEvents, because that function is ALSO called on a failed replay,
// where the conversation lives on and its pictures must live with it.

import { chatAttachment, db } from '@opencroft/db'
import type { AttachmentRef, PromptAttachment } from 'agent-client/attachments'
import { eq, inArray } from 'drizzle-orm'
import sharp from 'sharp'

/**
 * What a reader may attach.
 *
 * The list is what a vision model is actually served by the providers we reach,
 * not everything a browser will hand over: an SVG is a script host rather than
 * a picture, and a TIFF is a file no endpoint here accepts.
 */
export const ATTACHABLE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

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
  // Base64 is four characters per three bytes, with the padding standing in for
  // the bytes the last group does not have — so the size is known without
  // decoding a payload that might be refused anyway.
  const padding = input.data.endsWith('==') ? 2 : input.data.endsWith('=') ? 1 : 0
  const byteSize = Math.max(0, Math.floor((input.data.length * 3) / 4) - padding)
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
 * The references a send may carry, resolved from what the composer handed in.
 *
 * Ids only cross the wire; the name and type a message records are read here,
 * from the row, so a caller cannot label a picture as something it is not. And
 * every id must be a row of THIS conversation -- one that is not is refused
 * outright rather than dropped, since a send that quietly lost a picture is the
 * failure the whole feature is built against.
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
    .where(inArray(chatAttachment.id, [...ids]))
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
    const row = await readAttachment(sessionKey, id)
    if (row) {
      loaded.push({ id, ...row })
    }
  }
  return loaded
}

/**
 * One image for a surface that draws it -- the transcript, through
 * attachmentResponse. Scoped like loadAttachments: another conversation's id
 * answers null.
 */
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

export async function readAttachment(
  sessionKey: string,
  id: string,
): Promise<{ name: string; mimeType: string; data: string } | null> {
  const [row] = await db
    .select({
      name: chatAttachment.name,
      mimeType: chatAttachment.mimeType,
      data: chatAttachment.data,
      sessionKey: chatAttachment.sessionKey,
    })
    .from(chatAttachment)
    .where(eq(chatAttachment.id, id))
  return row && row.sessionKey === sessionKey ? { name: row.name, mimeType: row.mimeType, data: row.data } : null
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
