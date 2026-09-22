// The bytes behind an image a reader attached to a message.
//
// A message carries only an ID (see attachments.ts in agent-client): the tag in
// its text names a row here, and delivery turns that row into the ACP image
// block. So this is the one place the picture exists, which makes its lifetime
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
import type { PromptAttachment } from 'agent-client'
import { eq, inArray } from 'drizzle-orm'

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
    throw new AttachmentRejected(
      `that image is ${Math.round(byteSize / (1024 * 1024))} MB, over the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB limit`,
    )
  }
  const name = input.name.trim() || 'image'
  const [row] = await db
    .insert(chatAttachment)
    .values({ sessionKey: input.sessionKey, name, mimeType, data: input.data, byteSize })
    .returning({ id: chatAttachment.id })
  return { id: row.id, name, mimeType, byteSize }
}

/**
 * The attachments a delivery names, as the engine's `loadAttachments` hook.
 *
 * Scoped to the session key: an id is not a capability, and a message naming
 * another conversation's row must resolve to nothing rather than to its bytes.
 * Missing ids are simply absent from the answer — the engine reports the
 * shortfall in the transcript, which is the one place a reader would look.
 */
export async function loadAttachments(sessionKey: string, ids: readonly string[]): Promise<PromptAttachment[]> {
  if (ids.length === 0) {
    return []
  }
  const rows = await db
    .select({
      id: chatAttachment.id,
      name: chatAttachment.name,
      mimeType: chatAttachment.mimeType,
      data: chatAttachment.data,
      sessionKey: chatAttachment.sessionKey,
    })
    .from(chatAttachment)
    .where(inArray(chatAttachment.id, [...ids]))
  const byId = new Map(rows.filter((row) => row.sessionKey === sessionKey).map((row) => [row.id, row]))
  // Returned in the order the MESSAGE named them, not the order the database
  // happened to answer in: the blocks travel in that order and a reader who
  // attached two pictures meant the first one first.
  return ids.flatMap((id) => {
    const row = byId.get(id)
    return row ? [{ id: row.id, name: row.name, mimeType: row.mimeType, data: row.data }] : []
  })
}

/** One image for a surface that draws it (the transcript's own thumbnails). */
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
