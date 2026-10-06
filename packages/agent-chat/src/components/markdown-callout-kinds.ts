/*
 * The kinds of callout, apart from how one is drawn (`./markdown-callout`):
 * the markdown syntax reads and writes them on a server too, which must not
 * pull a React component in with them.
 */

export type MarkdownCalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

/** Every kind, in the order a picker offers them. */
export const MARKDOWN_CALLOUT_KINDS: readonly MarkdownCalloutKind[] = ['note', 'tip', 'important', 'warning', 'caution']
