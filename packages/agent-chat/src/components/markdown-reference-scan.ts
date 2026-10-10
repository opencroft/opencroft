import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { collectReferences, type InlineReference, type ReferenceRecogniser } from './markdown-references'
import { markdownSyntax } from './markdown-syntax'

const parser = unified().use(remarkParse).use(markdownSyntax)

/**
 * The references `recognisers` claim in a markdown text, in order: the ones
 * `Markdown` would draw, and no others. Runs without a DOM or an installed
 * source, for a server that acts on the references a reader is shown.
 */
export function referencesInMarkdown(text: string, recognisers: readonly ReferenceRecogniser[]): InlineReference[] {
  // `runSync` is typed for any processor; this one parses markdown, so its tree is mdast's root.
  return collectReferences(parser.runSync(parser.parse(text)) as Root, recognisers)
}
