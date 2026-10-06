// How much text one chat message may carry.
//
// A message is stored several times over -- as a queue entry while it waits,
// as an event of the session's recording, and as segments of the search index
// -- and the embedded database can return only about 15 MiB from one query.
// Pictures do not count: they travel as attachments, stored and limited on
// their own. So the limit is on the text a sender typed, measured before any
// framing the server adds around it.
//
// Dependency-free and in _shared because both sides check it: the composer
// refuses before sending, so the reader is told at once and keeps the text,
// and the server refuses whatever reaches it anyway, from any sender.

/** The most UTF-8 bytes of text one message may carry. */
export const MAX_MESSAGE_TEXT_BYTES = 1024 * 1024

const mebibytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)

const LIMIT_AND_REMEDY = `over the ${mebibytes(MAX_MESSAGE_TEXT_BYTES)} MiB a message can carry. Shorten it, or attach pictures instead of pasting them as text.`

/**
 * The refusal where only its kind is known -- a refusal mapped from its code,
 * which carries no size.
 */
export const OVERSIZED_TEXT_REFUSAL = `This message's text is ${LIMIT_AND_REMEDY}`

/**
 * The refusal for `text` when it is over the limit, written for the sender, or
 * null when it may be sent.
 */
export function oversizedTextNotice(text: string): string | null {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes <= MAX_MESSAGE_TEXT_BYTES) {
    return null
  }
  return `This message is ${mebibytes(bytes)} MiB of text, ${LIMIT_AND_REMEDY}`
}
