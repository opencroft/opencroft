import { type JSONContent, Mark, type MarkdownToken, mergeAttributes } from '@tiptap/core'

import { HINT_DIRECTIVE, HINT_TEXT_ATTRIBUTE } from './markdown-directives'
import { readAttribute } from './markdown-editor-directives'
import { ICON_NODE } from './markdown-editor-icon-node'
import { IMAGE_NODE } from './markdown-editor-image-node'

/*
 * A hint over inline content, as the editor reads and writes it:
 * `:hint[content]{text="…"}`, carrying the note over whatever its label
 * holds -- formatted text, icons, emoji.
 *
 * Text carries a hint as a mark. An icon or an image carries it as an
 * attribute of its own, `hint`, holding the note: a shared document (Yjs)
 * keeps the marks of text and drops those of every other node, so a mark on
 * an icon would be gone the next time the document loads.
 *
 * `Markdown` renders it through remark; the editor reads the syntax a second
 * time here, as an inline rule. What the directive is called and which
 * attribute it reads come from `components/markdown-directives`.
 */

export const HINT_MARK = 'markdownHint'

/** The attribute an icon or an image carries its hint in. */
export const HINT_ATTRIBUTE = 'hint'

/** The nodes other than text a hint can sit on, each carrying it in `HINT_ATTRIBUTE`. */
const HINT_ATTRIBUTE_NODES = [ICON_NODE, IMAGE_NODE]

/** Whether a node of `type` carries its hint in `HINT_ATTRIBUTE` rather than as a mark. */
export function takesHintAttribute(type: string | undefined): boolean {
  return type !== undefined && HINT_ATTRIBUTE_NODES.includes(type)
}

const HINT_DOM = 'data-md-hint'

// An icon's or an image's hint, in an HTML attribute apart from the mark's:
// the mark's rule claims any span with `HINT_DOM`, and would take an icon's
// own span for an empty hint, losing the icon on copy and paste.
const HINT_ATTRIBUTE_DOM = 'data-md-node-hint'

const HINT_TOKEN = 'markdownHint'

const HINT_OPENING = `:${HINT_DIRECTIVE}[`

interface HintToken extends MarkdownToken {
  text: string
}

/** Where the next hint may start, so the text before it ends there. */
function hintStart(src: string): number {
  return src.indexOf(HINT_OPENING)
}

/**
 * The end of the `[label]` opening at `src[open]`, just past its closing
 * bracket, or -1. Brackets nest and a backslash escapes the next character,
 * as remark-directive reads a label.
 */
function labelEnd(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const char = src[i]
    if (char === '\\') {
      i++
    } else if (char === '[') {
      depth++
    } else if (char === ']') {
      depth--
      if (depth === 0) {
        return i + 1
      }
    }
  }
  return -1
}

/** The end of the `{attributes}` opening at `src[open]`, past its closing brace, or -1. A quoted value may hold a brace. */
function attributesEnd(src: string, open: number): number {
  let quote: string | null = null
  for (let i = open + 1; i < src.length; i++) {
    const char = src[i]
    if (char === '\n') {
      return -1
    }
    if (quote) {
      quote = char === quote ? null : quote
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '}') {
      return i + 1
    }
  }
  return -1
}

/**
 * A hint at the start of `src`: its label read as inline markdown, its note
 * from its attributes. A colon right before is how remark-directive tells
 * `::name` apart, and that form is not a hint.
 */
function tokenizeHint(
  src: string,
  previous: MarkdownToken | undefined,
  inlineTokens: (src: string) => MarkdownToken[],
): HintToken | undefined {
  if (!src.startsWith(HINT_OPENING) || previous?.raw?.endsWith(':')) {
    return undefined
  }
  const labelOpen = HINT_OPENING.length - 1
  const label = labelEnd(src, labelOpen)
  if (label === -1) {
    return undefined
  }
  const attributes = src[label] === '{' ? attributesEnd(src, label) : -1
  const end = attributes === -1 ? label : attributes
  return {
    type: HINT_TOKEN,
    raw: src.slice(0, end),
    text: attributes === -1 ? '' : (readAttribute(src.slice(label, end), HINT_TEXT_ATTRIBUTE)?.trim() ?? ''),
    tokens: inlineTokens(src.slice(labelOpen + 1, label - 1)),
  }
}

/** A note as the one line an attribute value holds: runs of whitespace as one space. */
export function hintText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The markdown for a hint over `content`, itself markdown, as the renderer reads it back. */
export function formatHint(content: string, text: string): string {
  const value = hintText(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  return `:${HINT_DIRECTIVE}[${content}]{${HINT_TEXT_ATTRIBUTE}="${value}"}`
}

/** The note of the hint over `node`, from its mark or its attribute, or undefined. */
function hintOf(node: JSONContent): string | undefined {
  if (takesHintAttribute(node.type)) {
    return (node.attrs?.[HINT_ATTRIBUTE] as string | null | undefined) ?? undefined
  }
  if (node.type !== 'text') {
    return undefined
  }
  return node.marks?.find((mark) => mark.type === HINT_MARK)?.attrs?.text as string | undefined
}

/** Whether the markdown manager can write a mark around `node`: text, and not code, whose span holds no markup. */
function takesMarkSyntax(node: JSONContent): boolean {
  return node.type === 'text' && !node.marks?.some((mark) => mark.type === 'code')
}

/**
 * `content` with each run of neighbours under one hint -- the same note --
 * that holds anything but plain text gathered into a single node of the
 * hint's own type, holding the run without the hint.
 *
 * The markdown manager writes a mark around each text node it covers, inside
 * the marks around it; an icon carries its hint in an attribute, which the
 * manager knows nothing of; and a mark it writes over code lands inside the
 * code span, as literal text. Written from these nodes instead, such a hint
 * is one `:hint[…]` around everything it covers, and closes the marks open
 * around it. A run of plain text keeps the mark, so a hint on a word in bold
 * or in a link sits inside it. A hard break ends a run: a label is one line.
 */
export function gatherHints(content: JSONContent[]): JSONContent[] {
  const runs: { hint: string | undefined; nodes: JSONContent[] }[] = []
  for (const node of content) {
    const hint = hintOf(node)
    const last = runs.at(-1)
    if (hint !== undefined && last?.hint === hint) {
      last.nodes.push(node)
    } else {
      runs.push({ hint, nodes: [node] })
    }
  }
  return runs.flatMap(({ hint, nodes }) => {
    if (hint === undefined || nodes.every(takesMarkSyntax)) {
      return nodes.map((node) => (node.content ? { ...node, content: gatherHints(node.content) } : node))
    }
    const inner = nodes.map((node) => ({ ...node, marks: node.marks?.filter((mark) => mark.type !== HINT_MARK) }))
    return [{ type: HINT_MARK, attrs: { text: hint }, content: inner }]
  })
}

export const HintMark = Mark.create<{ HTMLAttributes: Record<string, unknown> }>({
  name: HINT_MARK,
  // Above a link's 1000: where marks start and end together the markdown
  // manager writes the higher priority outside, so a hint over a whole bold
  // word or link is `:hint[**…**]` however its marks were last ordered.
  priority: 1001,
  // Typing at either edge of a hint is outside it, as it is for a link.
  inclusive: false,
  addOptions() {
    return { HTMLAttributes: {} }
  },
  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute(HINT_DOM) ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({ [HINT_DOM]: attributes.text }),
      },
    }
  },
  // An icon's or an image's hint, drawn with the mark's own attributes.
  addGlobalAttributes() {
    return [
      {
        types: HINT_ATTRIBUTE_NODES,
        attributes: {
          [HINT_ATTRIBUTE]: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute(HINT_ATTRIBUTE_DOM) || null,
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes[HINT_ATTRIBUTE]
                ? mergeAttributes(this.options.HTMLAttributes, { [HINT_ATTRIBUTE_DOM]: attributes[HINT_ATTRIBUTE] })
                : {},
          },
        },
      },
    ]
  },
  parseHTML() {
    return [{ tag: `span[${HINT_DOM}]` }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0]
  },
  markdownTokenName: HINT_TOKEN,
  markdownTokenizer: {
    name: HINT_TOKEN,
    level: 'inline',
    start: hintStart,
    tokenize: (src, tokens, lexer) => tokenizeHint(src, tokens.at(-1), (label) => lexer.inlineTokens(label)),
  },
  // A hint with no note is its content alone, as the renderer draws it. The
  // hint goes on every node of the content, an icon in its attribute.
  parseMarkdown: (token, h) => {
    const { text } = token as HintToken
    const content = h.parseInline(token.tokens ?? [])
    if (text === '') {
      return content
    }
    return content.map((node) => {
      if (takesHintAttribute(node.type)) {
        return { ...node, attrs: { ...node.attrs, [HINT_ATTRIBUTE]: text } }
      }
      return node.type === 'text' ? { ...node, marks: [...(node.marks ?? []), { type: HINT_MARK, attrs: { text } }] } : node
    })
  },
  // Given a node `gatherHints` made, the whole run; given the mark itself,
  // which is how the manager asks for a mark's syntax, its two halves.
  renderMarkdown: (node, h) => formatHint(h.renderChildren(node), node.attrs?.text ?? ''),
})
