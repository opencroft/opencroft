// How a message names an image it carries.
//
// NODE-FREE, AND THAT IS PART OF THE CONTRACT: the composer that writes a tag
// runs in the browser, so this module imports nothing and must keep importing
// nothing. Client code reaches it by this path and not through the package
// index, which is the server entry and pulls the whole engine (node:fs
// included) in behind it — the same rule mcp-types.ts carries for the same
// reason. Importing it from the index is not a type error and not a test
// failure; it is a blank chat and a browser console.
//
// THE REFERENCE LIVES IN THE TEXT, and that is structural rather than a
// shortcut. A message can be held by a cadence, and a held message is stored as
// its text and nothing else; the transcript a reader sees is rebuilt from the
// delivered text too. A reference passed BESIDE the text would survive neither
// -- it would reach the harness when a message went straight through and vanish
// the moment the same message waited for a boundary, which is the worst kind of
// bug to own: it works while you are watching.
//
// So the composer writes a tag, the same way the host already marks a passed
// selection, and delivery turns each tag back into the ACP image block it
// stands for. The tag is NOT stripped on the way out: it is what names the file
// to a harness that cannot take images at all, and what the transcript reads
// back to draw the thumbnail after a reload.

/** What an attachment tag names. The bytes are fetched separately, by id. */
export interface AttachmentRef {
  id: string
  name: string
  mimeType: string
}

/** An attachment resolved to what an ACP image block carries. */
export interface PromptAttachment extends AttachmentRef {
  /** Base64 bytes with no `data:` prefix -- ContentBlock::Image's own shape. */
  data: string
}

const TAG_PATTERN = /<user-attachment\b([^>]*?)\/>/g
const ATTRIBUTE_PATTERN = /([a-z]+)="([^"]*)"/g

// A name is a label, not data anything reads back, so the three characters that
// could end the tag early are dropped rather than escaped. An escaping scheme
// would need a decoder on the other side, and the only reader is a chip.
function safeName(name: string): string {
  return name.replace(/[<>"]/g, '')
}

/** The tag a composer writes for one attachment. */
export function attachmentTag(ref: AttachmentRef): string {
  return `<user-attachment id="${ref.id}" name="${safeName(ref.name)}" type="${ref.mimeType}"/>`
}

/** Every attachment the text names, in the order it names them. */
export function attachmentRefsIn(text: string): AttachmentRef[] {
  const refs: AttachmentRef[] = []
  for (const [, attributes] of text.matchAll(TAG_PATTERN)) {
    const found: Record<string, string> = {}
    for (const [, key, value] of attributes.matchAll(ATTRIBUTE_PATTERN)) {
      found[key] = value
    }
    // The id is the whole of what makes a tag resolvable. A tag without one
    // names nothing that could be loaded, so it stays the text it already is
    // rather than becoming an attachment nobody can find.
    if (found.id) {
      refs.push({ id: found.id, name: found.name || found.id, mimeType: found.type || '' })
    }
  }
  return refs
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
