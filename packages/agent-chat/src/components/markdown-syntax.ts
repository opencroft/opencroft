import type { Parent, Root, RootContent } from 'mdast'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'

import { remarkDirectiveBlocks } from './markdown-directives'

/**
 * The directive syntax and the transform that shapes its blocks: what turns
 * `:::note` or `:icon[...]` into something other than prose. Runs before
 * references are found, because an icon's label is its name and not text.
 */
export const markdownDirectiveSyntax = [remarkDirective, remarkDirectiveBlocks]

/**
 * Everything `Markdown` reads a text with before it looks for references: the
 * one list that decides which parts of a text are prose. `Markdown` renders
 * with it and `referencesInMarkdown` scans with it, so a syntax added here
 * changes what is drawn and what is found together. Add one here rather than
 * to either of them. Free of React, so a server can parse with it.
 */
export const markdownSyntax = [remarkGfm, ...markdownDirectiveSyntax]

function breakLines(parent: Parent): void {
  parent.children = parent.children.flatMap((child): RootContent[] => {
    if (child.type === 'text' && child.value.includes('\n')) {
      return child.value
        .split('\n')
        .flatMap((line, index): RootContent[] => [
          ...(index > 0 ? [{ type: 'break' } as const] : []),
          ...(line ? [{ type: 'text', value: line } as const] : []),
        ])
    }
    if ('children' in child) {
      breakLines(child)
    }
    return [child]
  }) as typeof parent.children
}

/**
 * A line break inside a paragraph's text as a line break, where markdown
 * reads it as a space: the way a chat message is written. Code keeps its
 * own lines.
 */
export function remarkLineBreaks() {
  return (tree: Root) => breakLines(tree)
}
