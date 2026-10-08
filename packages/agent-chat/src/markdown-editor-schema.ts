import { type AnyExtension, getSchema } from '@tiptap/core'
import { CodeBlock } from '@tiptap/extension-code-block'
import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list'
import type { Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'

import { directiveSchemaExtensions } from './markdown-editor-directives'
import { IconSchemaNode } from './markdown-editor-icon-node'
import {
  createMarkdownConverter,
  type MarkdownConverter,
  MarkdownHardBreak,
  MarkdownLink,
  MarkdownParagraph,
} from './markdown-editor-markdown'
import { tableSchemaExtensions } from './markdown-editor-table-markdown'

/*
 * The markdown editor's document: its schema and how that reads and writes
 * markdown, with nothing that draws or edits it. The editor adds its views and
 * editing behaviour on top (`./markdown-editor`); anything that reads or writes
 * the editor's documents without one -- a server holding a document several
 * people edit -- uses this list, and so reads and writes exactly what the
 * editor does.
 */

/**
 * The ordered list, read by marked's own list rule and its items the way a
 * bullet list's are. The list's own tokenizer re-indents an item's nested
 * blocks one column short of a `1. ` marker, so a code block in a numbered
 * step gained a space on every save; and its item reader takes a tight item's
 * text as plain text, dropping the item's formatting.
 */
const MarkdownOrderedList = OrderedList.extend({
  // `null` and not `undefined`, which would fall back to the inherited tokenizer.
  markdownTokenizer: null as never,
  parseMarkdown: (token, h) => {
    if (token.type !== 'list' || !token.ordered) {
      return []
    }
    const start = typeof token.start === 'number' && token.start !== 1 ? { start: token.start } : undefined
    return { type: 'orderedList', ...(start ? { attrs: start } : {}), content: h.parseChildren(token.items ?? []) }
  },
})

/**
 * A fenced code block. Marked as `CodeBlock` marks its own, so a code block
 * takes the same size and no-wrap rule being edited as it does rendered.
 */
export const MarkdownCodeBlock = CodeBlock.configure({ HTMLAttributes: { 'data-code-block': '' } })

/**
 * The schema's extensions. `withViews` replaces nodes of the same name: the
 * editor passes the ones it draws with node views, which extend the nodes here
 * and so keep their schema and markdown.
 */
export function markdownSchemaExtensions(withViews: AnyExtension[] = []): AnyExtension[] {
  const views = new Map(withViews.map((extension) => [extension.name, extension]))
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      // Replaced below by versions that write markdown text the way this
      // product has always stored it.
      paragraph: false,
      hardBreak: false,
      link: false,
      orderedList: false,
      // Markdown has no underline, and the page renderer draws no `<u>`.
      underline: false,
      // Its own entry below, so the editor can draw it with a view.
      codeBlock: false,
      // Editing aids rather than content: the editor adds its own.
      undoRedo: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
    }),
    MarkdownCodeBlock,
    MarkdownParagraph,
    MarkdownHardBreak,
    // Not opened on click: inside an editor a click is how you put the caret
    // in the text, and autolink is what turns a typed URL into one.
    MarkdownLink.configure({ openOnClick: false, autolink: true }),
    MarkdownOrderedList,
    // GFM task items: without them `- [ ] x` reads as a plain item and the box is lost on save.
    TaskList,
    TaskItem.configure({ nested: true }),
    ...tableSchemaExtensions,
    ...directiveSchemaExtensions,
    IconSchemaNode,
  ]
  return extensions.map((extension) => views.get(extension.name) ?? extension)
}

let sharedConverter: MarkdownConverter | undefined
let sharedSchema: Schema | undefined

/** Reads and writes the editor's documents as markdown, the same in a browser and on a server. */
export function markdownConverter(): MarkdownConverter {
  sharedConverter ??= createMarkdownConverter(markdownSchemaExtensions())
  return sharedConverter
}

/** The editor's schema, for building and reading its documents without an editor. */
export function markdownSchema(): Schema {
  sharedSchema ??= getSchema(markdownSchemaExtensions())
  return sharedSchema
}
