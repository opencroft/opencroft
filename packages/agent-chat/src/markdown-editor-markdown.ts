import type { AnyExtension, JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Link } from '@tiptap/extension-link'
import { Paragraph } from '@tiptap/extension-paragraph'
import { MarkdownManager } from '@tiptap/markdown'
import { Marked, type marked, Tokenizer, type Tokens } from 'marked'

/*
 * How the editor reads and writes markdown: TipTap's own markdown manager over
 * a `marked` lexer of the editor's own, with the handful of rules below laid
 * over its defaults. The same converter runs in the browser and on a server,
 * and nothing here reaches for a DOM, so a document parsed on either side is
 * the same document.
 *
 * What is laid over the defaults, and why each one:
 *
 * - Text is written the way markdown text has always been written here: the
 *   inline syntax characters backslash-escaped, `<` and `>` as entities, and an
 *   ampersand left alone unless it would read back as an entity. The manager's
 *   own encoder turns every `&` into `&amp;`, which rewrites every ampersand in
 *   a page the first time anyone edits it.
 * - A line of text that markdown would read as something else -- a heading, a
 *   list item, a directive fence -- has its first character escaped, so typed
 *   text reads back as the text it was. The manager escapes inline syntax only.
 * - A hard break is a backslash at the end of the line, not two trailing
 *   spaces, which any editor or formatter that trims whitespace silently drops.
 * - A link whose text is its address is written as an autolink, `<https://...>`,
 *   with the address unescaped.
 * - A line break in a paragraph's source is a space, as the page renders it.
 * - HTML is text. `<br>` is a line break, as it is in a table cell, and any
 *   other tag reads back as the characters it was written with. Turning HTML
 *   into rich text needs a DOM, which a server does not have, and a converter
 *   that reads the same markdown two ways depending on where it runs would make
 *   a document depend on who opened it.
 */

/** How a hard break is written. */
export const HARD_BREAK_MARKDOWN = '\\\n'

const BREAK_TAG = /^<br\s*\/?>$/i

/**
 * A `marked` instance of the converter's own. The manager registers each
 * extension's tokenizer into the instance it is given, and the default is
 * marked's module-wide one: two converters on it would each add their
 * tokenizers again.
 */
function createLexer(): typeof marked {
  const instance = new Marked()
  instance.use({
    tokenizer: {
      // A line break inside a paragraph's source is a space in the text, as
      // the rendered page shows it. Kept as a newline it would show as one in
      // the editor, and break the paragraph across lines that a list item
      // then reads back differently.
      inlineText(src) {
        const token = Tokenizer.prototype.inlineText.call(this, src)
        return token ? { ...token, text: token.text.replace(/[ \t]*\n[ \t]*/g, ' ') } : false
      },
      // Inline HTML: `<br>` is marked's own line-break token, anything else is
      // its own characters.
      tag(src) {
        const token = Tokenizer.prototype.tag.call(this, src)
        if (!token) {
          return false
        }
        const raw = token.raw
        return (BREAK_TAG.test(raw) ? { type: 'br', raw } : { type: 'text', raw, text: raw }) as unknown as Tokens.Tag
      },
      // Block HTML: a paragraph holding its characters.
      html(src) {
        const token = Tokenizer.prototype.html.call(this, src)
        if (!token) {
          return false
        }
        const text = token.raw.replace(/\s+$/, '')
        return {
          type: 'paragraph',
          raw: token.raw,
          text,
          tokens: [{ type: 'text', raw: text, text }],
        } as unknown as Tokens.HTML
      },
    },
  })
  // The manager's option is typed as marked's module-wide object; it uses
  // only what an instance has as well (`use`, `defaults`, `Lexer`, `lexer`).
  return instance as unknown as typeof marked
}

const ENTITY_LIKE = /&(?=#\d+;|#x[\da-f]+;|[a-z][a-z\d]*;)/gi

/** Plain text as markdown: inline syntax escaped, angle brackets as entities. */
export function escapeMarkdownText(text: string): string {
  return text
    .replace(ENTITY_LIKE, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]~])/g, '\\$1')
}

/**
 * Escapes what would make a line of text read back as something other than
 * text: a heading's `#`, a list item's `-`, `+` or `1.`, a directive fence's
 * colons. A `*` or a `>` needs nothing here; text never starts with either
 * unescaped.
 */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(\+(?= )|-|:{3})/, '\\$1')
}

interface LinkAttributes {
  href?: string
  title?: string | null
}

/** The address of a link that is its own text, or null for any other text. */
function plainUrl(node: JSONContent): string | null {
  const link = node.marks?.find((mark) => mark.type === 'link')
  const attrs = link?.attrs as LinkAttributes | undefined
  if (!attrs?.href || attrs.title || node.text !== attrs.href || !/^[a-z][a-z\d+.-]*:/i.test(attrs.href)) {
    return null
  }
  return attrs.href
}

type TextEncoder = (text: string, node: JSONContent, parentNode?: JSONContent) => string

/**
 * The manager's text encoder, replaced. It is a private method, so this is
 * pinned by a test that serializes an ampersand: if an upgrade renames the
 * method, that test fails rather than every page's ampersands quietly turning
 * into entities.
 */
function encodeTextLikeMarkdown(manager: MarkdownManager): void {
  const internals = manager as unknown as { encodeTextForMarkdown: TextEncoder; codeTypes: Set<string> }
  const isCode = (type: string | undefined) => type !== undefined && internals.codeTypes.has(type)
  internals.encodeTextForMarkdown = (text, node, parentNode) => {
    if (isCode(parentNode?.type) || node.marks?.some((mark) => isCode(mark.type)) || plainUrl(node) !== null) {
      return text
    }
    return escapeMarkdownText(text)
  }
}

/** The lines of a textblock's inline content, split at its hard breaks. */
function linesOf(content: JSONContent[]): JSONContent[][] {
  const lines: JSONContent[][] = [[]]
  for (const node of content) {
    if (node.type === 'hardBreak') {
      lines.push([])
    } else {
      lines[lines.length - 1].push(node)
    }
  }
  return lines
}

/**
 * Inline content as markdown, line by line, joined with `separator`. Where
 * each line starts a line of the written markdown, `escapeStarts` escapes the
 * ones that start with unmarked text: text under a mark starts after the
 * mark's own syntax, where nothing needs escaping.
 */
export function renderInlineLines(
  content: JSONContent[],
  h: MarkdownRendererHelpers,
  { separator, escapeStarts }: { separator: string; escapeStarts: boolean },
): string {
  return linesOf(content)
    .map((line) => {
      const markdown = h.renderChildren(line)
      const first = line[0]
      return escapeStarts && first?.type === 'text' && !first.marks?.length ? escapeLineStart(markdown) : markdown
    })
    .join(separator)
}

/** StarterKit's paragraph, writing its text as described above. */
export const MarkdownParagraph = Paragraph.extend({
  renderMarkdown(node, h, ctx) {
    const content: JSONContent[] = node.content ?? []
    if (content.length === 0) {
      // An empty paragraph's spacing rules are the manager's own.
      return this.parent?.(node, h, ctx) ?? ''
    }
    return renderInlineLines(content, h, { separator: HARD_BREAK_MARKDOWN, escapeStarts: true })
  },
})

/** StarterKit's hard break, written as a backslash at the end of the line. */
export const MarkdownHardBreak = HardBreak.extend({
  renderMarkdown: () => HARD_BREAK_MARKDOWN,
})

/** StarterKit's link, writing an address that is its own text as an autolink. */
export const MarkdownLink = Link.extend({
  renderMarkdown(node, h, ctx) {
    const attrs = (node.attrs ?? {}) as LinkAttributes
    const text = h.renderChildren(node)
    // The manager asks a mark for its syntax around a placeholder, and passes
    // the text the mark actually covers alongside.
    const covered = ctx?.meta?.markText as string | undefined
    if (plainUrl({ type: 'text', text: covered, marks: [{ type: 'link', attrs }] }) !== null) {
      return `<${text}>`
    }
    return attrs.title ? `[${text}](${attrs.href} "${attrs.title}")` : `[${text}](${attrs.href})`
  },
})

/** Reads and writes the markdown of one schema's documents. */
export interface MarkdownConverter {
  /** A document's JSON; empty markdown is a document holding one empty paragraph. */
  parse(markdown: string): JSONContent
  serialize(doc: JSONContent): string
}

/** A converter for the schema `extensions` make. */
export function createMarkdownConverter(extensions: AnyExtension[]): MarkdownConverter {
  const manager = new MarkdownManager({ marked: createLexer(), extensions })
  encodeTextLikeMarkdown(manager)
  return {
    parse: (markdown) => {
      const doc = manager.parse(markdown)
      return doc.content?.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] }
    },
    // Without the blank lines an empty last paragraph leaves, which an editor
    // keeps after a final block for the caret to go to.
    serialize: (doc) => manager.serialize(doc).replace(/\n+$/, ''),
  }
}
