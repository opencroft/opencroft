import { type MarkdownLexerConfiguration, type MarkdownToken, Node } from '@tiptap/core'

import { ICON_COLOR_ATTRIBUTE, ICON_DIRECTIVE } from './components/markdown-directives'
import { labelText, readAttribute } from './markdown-editor-directives'

/*
 * An icon in the text, as the editor reads and writes it:
 * `:icon[rocket]{color=primary}`, one atom node carrying the name and colour.
 *
 * `Markdown` renders it through remark; the editor reads the syntax a second
 * time here, as an inline rule. What the directive is called and which
 * attribute it reads come from `components/markdown-directives`. How the icon
 * looks and is edited is `./markdown-editor-icon`, which adds the node view.
 */

export const ICON_NODE = 'markdownIcon'

const ICON_DOM = { name: 'data-md-icon', color: 'data-md-color' } as const

const ICON_TOKEN = 'markdownIcon'

// The directive's name, a `[label]` on the same line, and optional
// `{attributes}`, as remark-directive reads the text form.
const ICON_SOURCE = new RegExp(`^:${ICON_DIRECTIVE}(\\[[^\\]\\n]*\\])(\\{[^}\\n]*\\})?`)

const ICON_START = new RegExp(`:${ICON_DIRECTIVE}\\[`, 'g')

interface IconToken extends MarkdownToken {
  name: string
  color?: string
}

/** Where the next icon may start, so the text before it ends there. */
function iconStart(src: string): number {
  ICON_START.lastIndex = 0
  return ICON_START.exec(src)?.index ?? -1
}

/**
 * An icon at the start of `src`. A colon right before is how remark-directive
 * tells `::name` apart, and that form is not an icon; the colon is the end of
 * the token read just before, which is the one place that still knows it.
 */
function tokenizeIcon(
  src: string,
  previous: MarkdownToken | undefined,
  lexer: MarkdownLexerConfiguration,
): IconToken | undefined {
  const match = ICON_SOURCE.exec(src)
  const name = match ? labelText(match[1], lexer) : ''
  if (!match || name === '' || previous?.raw?.endsWith(':')) {
    return undefined
  }
  return {
    type: ICON_TOKEN,
    raw: match[0],
    name,
    color: match[2] ? readAttribute(match[2], ICON_COLOR_ATTRIBUTE) : undefined,
  }
}

/** The markdown for an icon, as the renderer reads it back. */
export function formatIcon(name: string, color?: string | null): string {
  return `:${ICON_DIRECTIVE}[${name}]${color ? `{${ICON_COLOR_ATTRIBUTE}=${color}}` : ''}`
}

export const IconSchemaNode = Node.create({
  name: ICON_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  // Not selectable, the way an emoji character is not: the arrow keys step
  // over the icon in one move instead of stopping on it, and Shift+arrow
  // takes it into a selection like any character.
  selectable: false,
  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute(ICON_DOM.name) ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({ [ICON_DOM.name]: attributes.name }),
      },
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute(ICON_DOM.color) || null,
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.color ? { [ICON_DOM.color]: attributes.color } : {},
      },
    }
  },
  parseHTML() {
    return [{ tag: `span[${ICON_DOM.name}]` }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', HTMLAttributes]
  },
  markdownTokenName: ICON_TOKEN,
  markdownTokenizer: {
    name: ICON_TOKEN,
    level: 'inline',
    start: iconStart,
    tokenize: (src, tokens, lexer) => tokenizeIcon(src, tokens.at(-1), lexer),
  },
  parseMarkdown: (token, h) => {
    const { name, color } = token as IconToken
    return h.createNode(ICON_NODE, { name, color: color ?? null })
  },
  renderMarkdown: (node) => formatIcon(node.attrs?.name as string, node.attrs?.color as string | null),
})
