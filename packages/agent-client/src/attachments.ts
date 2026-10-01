// How a message carries the images attached to it.
//
// NODE-FREE, AND THAT IS PART OF THE CONTRACT: the composer that holds these
// runs in the browser, so this module imports nothing and must keep importing
// nothing. Client code reaches it by this path and not through the package
// index, which is the server entry and pulls the whole engine (node:fs
// included) in behind it — the same rule mcp-types.ts carries for the same
// reason. Importing it from the index is not a type error and not a test
// failure; it is a blank chat and a browser console.
//
// BESIDE THE TEXT, NEVER IN IT. A message's words are what somebody wrote, and
// anything read back out of them is something anybody can write: a reference
// spelled into the text reaches the harness from a pasted line exactly as it
// does from the composer, and shows in the bubble as markup. So an attachment
// is a field of its own at every stage the words pass through — the prompt
// call, the queue entry (held and made durable with it), the delivered `user`
// event the transcript is drawn from — and becomes the ACP image block it
// stands for only at delivery, which is the shape ACP gives a prompt anyway.

/** What an attachment is known by. The bytes are fetched separately, by id. */
export interface AttachmentRef {
  id: string
  name: string
  mimeType: string
  /**
   * The picture's size in pixels as it displays (any orientation it records
   * already applied), when the host knows it. Present lets a surface lay the
   * picture out at its final size before the bytes arrive, so a late image
   * moves nothing. Both or neither.
   */
  width?: number
  height?: number
}

/**
 * An attachment as a delivery records it: which of the delivery's messages it
 * came with, by position, since one delivery can join several (see queue-tags).
 * On a queued entry the position is within that entry — 0 for an ordinary
 * message, which is one message.
 */
export interface DeliveredAttachment extends AttachmentRef {
  message: number
}

/** An attachment resolved to what an ACP image block carries. */
export interface PromptAttachment extends AttachmentRef {
  /** Base64 bytes with no `data:` prefix -- ContentBlock::Image's own shape. */
  data: string
}

/**
 * Whether a mime type may travel as `ContentBlock::Image`.
 *
 * Checked at the boundary rather than trusted: the store is the host's, and a
 * PDF handed over as an image block is a mid-turn failure from the harness
 * instead of something this side reported.
 */
export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}
