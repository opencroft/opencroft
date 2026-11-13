import type { JSONContent } from '@tiptap/core'
import type { Nodes } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { HINT_DIRECTIVE, ICON_DIRECTIVE } from './markdown-directives'
import { markdownSyntax } from './markdown-syntax'
import { gatherHints } from './markdown-editor-hint-mark'
import {
  createMarkdownConverter,
  type MarkdownConverter,
  MarkdownLink,
  MarkdownParagraph,
  renderInlineLines,
} from './markdown-editor-markdown'
import { markdownSchemaExtensions } from './markdown-editor-schema'

/*
 * The agent dialect: markdown for text that is read as written -- by an agent
 * that takes it raw, as a chat message or instructions it is given -- and also
 * drawn as markdown (`Markdown` with `lineBreaks`, whose parser is
 * `markdownSyntax`). The editor's documents, with text written as it was
 * typed wherever that parser reads it back as that text. A backslash the
 * drawn text hides is one the raw reader still reads, in a path or a name it
 * then copies.
 *
 * So a character is escaped only where the parser would otherwise read it as
 * syntax, and a line break in a paragraph is a plain newline, which the drawn
 * text shows as one. Reading markdown back the same way, a newline between
 * two lines of a paragraph is a line break, so text opened for editing has
 * the lines it was written with.
 */

const WORD_CHARACTER = /[\p{L}\p{N}]/u
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/
const ENTITY = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i
// A text directive `Markdown` draws as something other than its text.
const DRAWN_DIRECTIVE = new RegExp(`^:(?:${ICON_DIRECTIVE}|${HINT_DIRECTIVE})\\[`)
// A bracket opening a link, an image, a reference, or a definition one of
// those could use. A reference with no definition reads as its text.
const LINK_OPENING = /^\[[^\]]*\][([:]/

/** The text of a textblock, a line break as a newline. */
function blockText(content: JSONContent[]): string {
  return content.map((node) => (node.type === 'text' ? (node.text ?? '') : node.type === 'hardBreak' ? '\n' : '')).join('')
}

const addressParser = unified().use(remarkParse).use(markdownSyntax)
let lastAddresses: { text: string; ranges: [number, number][] } | undefined

/**
 * Where the drawn text's parser finds an address written into `text` as it
 * stands, as `[start, end)` offsets. GFM takes everything inside such an
 * address as the address, an underscore, an asterisk or a tilde included, and
 * a backslash there would be part of the link. Asked of the text as typed:
 * an address the parser takes as part of something else there, such as code
 * in backticks or an `<address>`, is not counted, and is escaped as text.
 */
function addressRanges(text: string): [number, number][] {
  if (!/:\/\/|www\.|@/.test(text)) {
    return []
  }
  if (lastAddresses?.text !== text) {
    const ranges: [number, number][] = []
    const visit = (node: Nodes) => {
      if (node.type === 'link') {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        const shown = node.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
        // Found as written: the address itself, not an `<address>` or a `[text](address)`.
        if (start !== undefined && end !== undefined && text.slice(start, end) === shown) {
          ranges.push([start, end])
        }
      } else if ('children' in node) {
        node.children.forEach(visit)
      }
    }
    visit(addressParser.parse(text))
    lastAddresses = { text, ranges }
  }
  return lastAddresses.ranges
}

/** Whether two text nodes carry the same marks, so nothing is written between them. */
function sameMarks(a: JSONContent, b: JSONContent): boolean {
  return JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? [])
}

/**
 * One text node of agent-dialect text as markdown. Around a character, what
 * counts is what the written markdown has there: a neighbouring text node's
 * character where nothing is written between the two, otherwise the edge of
 * a mark's syntax, which is read as no text at all.
 */
export function escapeAgentText(text: string, node: JSONContent, block?: JSONContent): string {
  const siblings = block?.content ?? [node]
  const index = siblings.indexOf(node)
  const previous = index > 0 ? siblings[index - 1] : undefined
  const next = index >= 0 ? siblings[index + 1] : undefined
  const before = previous?.type === 'text' && sameMarks(previous, node) ? (previous.text ?? '').slice(-1) : ''
  const after = next?.type === 'text' && sameMarks(next, node) ? (next.text ?? '').charAt(0) : ''
  const whole = blockText(siblings)
  const offset = blockText(index > 0 ? siblings.slice(0, index) : []).length
  const addresses = addressRanges(whole)
  const inAddress = (at: number) => addresses.some(([start, end]) => at >= start && at < end)
  const tildes = [...whole.matchAll(/~/g)].filter((match) => !inAddress(match.index)).length
  // Where an underscore stands outside a word, the only place GFM reads one
  // as emphasis, which takes two.
  const edgeUnderscores = [...whole.matchAll(/_/g)]
    .map((match) => match.index)
    .filter(
      (at) =>
        !inAddress(at) && !(WORD_CHARACTER.test(whole.charAt(at - 1)) && WORD_CHARACTER.test(whole.charAt(at + 1))),
    )

  let out = ''
  for (let i = 0; i < text.length; i++) {
    const character = text[i]
    if (inAddress(offset + i)) {
      out += character
      continue
    }
    const prior = i > 0 ? text[i - 1] : before
    const following = i + 1 < text.length ? text[i + 1] : after
    const rest = text.slice(i) + after
    let escape: boolean
    switch (character) {
      case '\\':
        // Before punctuation it is an escape, and at a line's end a line break.
        escape = following === '' || ASCII_PUNCTUATION.test(following)
        break
      case '*':
      case '`':
        escape = true
        break
      case '_':
        // GFM never reads an underscore inside a word as emphasis, nor one
        // with no other in the block to pair with.
        escape =
          !(WORD_CHARACTER.test(prior) && WORD_CHARACTER.test(following)) &&
          edgeUnderscores.some((at) => at !== offset + i)
        break
      case '~':
        // A pair strikes through, a single tilde at either side.
        escape = tildes > 1
        break
      case '[':
        escape = LINK_OPENING.test(whole.slice(offset + i))
        break
      case '<': {
        // An autolink or a tag, which `Markdown` drops: closed by a `>`
        // later in the block, or at a line's start, where a tag's name alone
        // opens a block of HTML.
        const at = offset + i
        const lineStart = whole.lastIndexOf('\n', at - 1) + 1
        escape =
          /[A-Za-z/!?]/.test(following) && (whole.includes('>', at) || whole.slice(lineStart, at).trim() === '')
        break
      }
      case '&':
        escape = ENTITY.test(rest)
        break
      case ':':
        escape = DRAWN_DIRECTIVE.test(rest)
        break
      default:
        escape = false
    }
    out += escape ? `\\${character}` : character
  }
  return out
}

/**
 * Escapes what would make a line of agent-dialect text read back as something
 * other than text: a heading's `#`, a list item's `-`, `+` or `1.`, a quote's
 * `>`, a directive fence's colons, and a line of only dashes, equals signs,
 * colons and pipes, which underlines the line above as a heading or makes it
 * a table's head.
 */
export function escapeAgentLineStart(line: string): string {
  if (/^[\s|:=-]+$/.test(line) && /[-=|]/.test(line)) {
    return line.replace(/^(\s*)(\S)/, '$1\\$2')
  }
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([-+](?=\s|$)|>|:{3})/, '$1\\$2')
}

/** The paragraph as the agent dialect writes it: its lines on lines of their own. */
const AgentMarkdownParagraph = MarkdownParagraph.extend({
  renderMarkdown(node, h, ctx) {
    const content: JSONContent[] = node.content ?? []
    if (content.length === 0) {
      return this.parent?.(node, h, ctx) ?? ''
    }
    return renderInlineLines(content, h, { separator: '\n', escapeStart: escapeAgentLineStart })
  },
})

/**
 * The link as the agent dialect writes it: an address typed into the text, which
 * the editor makes a link as it is typed, is written as the address alone.
 * GFM finds it in the text again, as it does an address typed anywhere else
 * in the text, with the same target: the address itself, `http://` before
 * one starting `www.`, `mailto:` before an e-mail address. A name the editor
 * takes for an address and GFM doesn't, such as `app.py`, which the editor
 * links to `http://app.py`, is text as typed.
 */
const AgentMarkdownLink = MarkdownLink.extend({
  renderMarkdown(node, h, ctx) {
    const attrs = (node.attrs ?? {}) as { href?: string; title?: string | null }
    // The manager asks a mark for its syntax around a placeholder, and passes
    // the text the mark actually covers alongside.
    const covered = ctx?.meta?.markText as string | undefined
    const typed =
      covered !== undefined &&
      !attrs.title &&
      (attrs.href === covered || attrs.href === `http://${covered}` || attrs.href === `mailto:${covered}`)
    return typed ? h.renderChildren(node) : (this.parent?.(node, h, ctx) ?? '')
  },
})

let sharedAgentConverter: MarkdownConverter | undefined

/** Reads and writes the editor's documents in the agent dialect. */
export function agentMarkdownConverter(): MarkdownConverter {
  sharedAgentConverter ??= createMarkdownConverter(
    markdownSchemaExtensions([AgentMarkdownParagraph, AgentMarkdownLink]),
    (doc) => gatherHints([doc])[0],
    { escapeText: escapeAgentText, lineBreaks: true },
  )
  return sharedAgentConverter
}

/** Plain typed text as the editor's document: its lines as line breaks, nothing read as markdown. */
export function typedDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: text
          .split(/\r\n?|\n/)
          .flatMap((line, index): JSONContent[] => [
            ...(index > 0 ? [{ type: 'hardBreak' }] : []),
            ...(line ? [{ type: 'text', text: line }] : []),
          ]),
      },
    ],
  }
}

/**
 * Pasted text as the agent dialect reads it: as agent-dialect markdown, its
 * lines kept; a Shift-paste (`plain`) as typed.
 */
export function readAgentPaste(text: string, plain: boolean): JSONContent {
  return plain ? typedDoc(text) : agentMarkdownConverter().parse(text)
}
