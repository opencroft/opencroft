// What a client and the collaboration server agree on about a shared markdown
// document, beyond what they agree on for every document
// (`@/lib/collab-protocol`).

export const MARKDOWN_DOC_PREFIX = 'md'

/** The XML fragment a markdown document's content lives in: the editor binding's default. */
export const MARKDOWN_DOC_FIELD = 'default'

/**
 * The collaboration server's name for a markdown document: `owner` is who
 * stores it -- an extension and a kind of document, which hold no colon --
 * and `key` which document of theirs it is.
 */
export function markdownDocName(owner: string, key: string): string {
  return `${MARKDOWN_DOC_PREFIX}:${owner}:${key}`
}

/** The owner and key a document name refers to, or null for another kind of document. */
export function parseMarkdownDocName(name: string): { owner: string; key: string } | null {
  if (!name.startsWith(`${MARKDOWN_DOC_PREFIX}:`)) {
    return null
  }
  const rest = name.slice(MARKDOWN_DOC_PREFIX.length + 1)
  const colon = rest.indexOf(':')
  return colon > 0 ? { owner: rest.slice(0, colon), key: rest.slice(colon + 1) } : null
}

/** Who changed a markdown document from outside an editor, as the change is announced. */
export interface MarkdownEditOrigin {
  kind: 'agent' | 'user'
  name: string
}

/**
 * Sent to every editor of a document after a change made outside one -- an
 * agent's -- since a Yjs update itself does not say who made it. `from` and
 * `to` bound the new content (`changedRange` in `@/lib/markdown-doc-change`),
 * as Yjs relative positions (`Y.relativePositionToJSON`), so each editor finds
 * them in its own copy. What the change replaced each editor takes from its
 * own copy as it drew it, when the change arrives.
 */
export interface MarkdownEditMessage {
  type: 'markdown-edit'
  origin: MarkdownEditOrigin
  from: unknown
  to: unknown
}
