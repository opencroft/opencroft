import { Extension, type JSONContent, type MarkdownLexerConfiguration, type MarkdownToken, Node } from '@tiptap/core'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'

import {
  blockAttribute,
  isCalloutKind,
  SPOILER_DIRECTIVE,
  TAB_DIRECTIVE,
  TABS_DIRECTIVE,
} from './components/markdown-directives'

/*
 * The documentation blocks as the editor reads and writes them: the
 * container-directive syntax, and the schema nodes it becomes -- a callout, a
 * spoiler, tabs of tabs, and a node for any directive the editor does not know,
 * which keeps it exactly as it was read so that opening and saving a page never
 * rewrites or loses a block added after this editor was written.
 *
 * `Markdown` renders these through remark; the editor reads them a second time
 * here, by the rule remark-directive and markdown-it-container share: a fence
 * of three or more colons opens a block, and the first line of at least as
 * many colons and nothing else closes it. Fences do not count nesting, so a
 * block holding another is written with a longer fence. What each name MEANS
 * -- which names are blocks, which attribute each reads -- is not restated: it
 * comes from `components/markdown-directives`.
 *
 * How the blocks look while edited is `./markdown-editor-blocks`, which adds
 * node views to the nodes defined here; nothing in this file needs a DOM.
 */

/** Node names of the directive blocks in the editor's schema. */
export const DIRECTIVE_NODES = {
  callout: 'markdownCallout',
  spoiler: 'markdownSpoiler',
  tabs: 'markdownTabs',
  tab: 'markdownTab',
  unknown: 'markdownDirective',
} as const

const DIRECTIVE_NODE_NAMES: readonly string[] = Object.values(DIRECTIVE_NODES)

/** The DOM attributes a block carries in the editor's HTML, which copy and paste read back. */
export const DIRECTIVE_DOM = {
  name: 'data-md-directive',
  heading: 'data-md-heading',
  info: 'data-md-info',
} as const

const DIRECTIVE_TOKEN = 'markdownDirectiveBlock'

// Name, then an optional `[label]`, then optional `{attributes}`, as
// remark-directive reads a container's opening line.
const INFO = /^\s*([A-Za-z][\w-]*)(\[[^\]\n]*\])?(\{.*\})?\s*$/

const OPENING = /^ {0,3}(:{3,})([^\n]*)(?:\n|$)/

const CLOSING = /^ {0,3}(:{3,})[ \t]*$/

const ATTRIBUTE = /([.#]?)([^\s"'={}.#]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]+)))?/g

const CHARACTER_REFERENCE = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][a-zA-Z\d]{0,31}));/g

/** Text with its backslash escapes and character references resolved, as markdown reads text. */
export function unescapeMarkdown(text: string): string {
  return text
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(CHARACTER_REFERENCE, (reference, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) {
        const decoded = decodeNamedCharacterReference(name)
        return decoded === false ? reference : decoded
      }
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�'
    })
}

/** The value of one attribute in a `{...}` list, or undefined when the list does not set it. */
export function readAttribute(list: string, wanted: string): string | undefined {
  for (const match of list.slice(1, -1).matchAll(ATTRIBUTE)) {
    const [, prefix, key, doubleQuoted, singleQuoted, bare] = match
    if (prefix === '' && key === wanted) {
      return unescapeMarkdown(doubleQuoted ?? singleQuoted ?? bare ?? '')
    }
  }
  return undefined
}

function plainText(tokens: MarkdownToken[]): string {
  return tokens
    .map((token) => {
      if (token.tokens?.length) {
        return plainText(token.tokens)
      }
      return token.type === 'text' || token.type === 'codespan' || token.type === 'escape'
        ? unescapeMarkdown(token.text ?? '')
        : ''
    })
    .join('')
}

/** A `[label]`'s text without its markup, as the renderer reads one. */
export function labelText(label: string, lexer: MarkdownLexerConfiguration): string {
  return plainText(lexer.inlineTokens(label.slice(1, -1))).trim()
}

function escapeAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * The info line for a block the editor knows: its name, and its one attribute
 * when that is set. Written in attribute form even when it was read from a
 * label, because the attribute form is the one every reader of the syntax
 * agrees on.
 */
export function formatDirectiveInfo(name: string, heading: string): string {
  const attribute = blockAttribute(name)
  const value = heading.replace(/\s+/g, ' ').trim()
  return attribute && value !== '' ? `${name}{${attribute}="${escapeAttributeValue(value)}"}` : name
}

interface DirectiveToken extends MarkdownToken {
  name: string
  /** The opening line after the name, exactly as written: label and attributes. */
  info: string
  /** What the block's one attribute says, else its label as text; empty for a block that reads none. */
  heading: string
}

function isDirectiveToken(token: MarkdownToken): token is DirectiveToken {
  return token.type === DIRECTIVE_TOKEN
}

/**
 * Where the next opening fence starts, so the paragraph before it ends there.
 * marked asks from one character into the paragraph, so the start of `src` is
 * not the start of a line: only a fence after a newline counts. Without that,
 * `\:::note` would be cut after its backslash and read as a block.
 */
function openingAt(src: string): number {
  for (const match of src.matchAll(/^ {0,3}:{3,}([^\n]*)$/gm)) {
    if (match.index > 0 && INFO.test(match[1])) {
      return match.index
    }
  }
  return -1
}

/** One container directive at the start of `src`; a fence never closed runs to the end. */
function tokenizeDirective(src: string, lexer: MarkdownLexerConfiguration): DirectiveToken | undefined {
  const opening = OPENING.exec(src)
  const info = opening ? INFO.exec(opening[2]) : null
  if (!opening || !info) {
    return undefined
  }
  const fence = opening[1].length
  let bodyEnd = src.length
  let end = src.length
  for (let pos = opening[0].length; pos < src.length; ) {
    const newline = src.indexOf('\n', pos)
    const lineEnd = newline === -1 ? src.length : newline
    const closing = CLOSING.exec(src.slice(pos, lineEnd))
    if (closing && closing[1].length >= fence) {
      bodyEnd = pos
      end = newline === -1 ? src.length : newline + 1
      break
    }
    pos = lineEnd + 1
  }
  const [, name, label = '', attributes = ''] = info
  const attribute = blockAttribute(name)
  const heading = attribute
    ? ((attributes ? readAttribute(attributes, attribute) : undefined) ?? (label ? labelText(label, lexer) : ''))
    : ''
  return {
    type: DIRECTIVE_TOKEN,
    raw: src.slice(0, end),
    name,
    info: label + attributes,
    heading,
    tokens: lexer.blockTokens(src.slice(opening[0].length, bodyEnd)),
  }
}

type ParseChildren = (tokens: MarkdownToken[]) => JSONContent[]

/** A block's body: what it holds, or one empty paragraph, which every block must hold at least. */
function bodyOf(token: MarkdownToken, parseChildren: ParseChildren): JSONContent[] {
  const content = parseChildren(token.tokens ?? [])
  return content.length > 0 ? content : [{ type: 'paragraph' }]
}

function directiveNode(token: DirectiveToken, parseChildren: ParseChildren): JSONContent {
  const { name, heading } = token
  if (isCalloutKind(name)) {
    return { type: DIRECTIVE_NODES.callout, attrs: { kind: name, heading }, content: bodyOf(token, parseChildren) }
  }
  if (name === SPOILER_DIRECTIVE) {
    return { type: DIRECTIVE_NODES.spoiler, attrs: { heading }, content: bodyOf(token, parseChildren) }
  }
  const children = (token.tokens ?? []).filter((child) => child.type !== 'space')
  const tabs = children.filter(isDirectiveToken).filter((child) => child.name === TAB_DIRECTIVE)
  if (name === TABS_DIRECTIVE && children.length > 0 && tabs.length === children.length) {
    return {
      type: DIRECTIVE_NODES.tabs,
      content: tabs.map((tab) => ({
        type: DIRECTIVE_NODES.tab,
        attrs: { heading: tab.heading },
        content: bodyOf(tab, parseChildren),
      })),
    }
  }
  // Includes a `tabs` holding anything besides tabs, and a `tab` outside one:
  // kept as written, so nothing the author wrote is dropped.
  return { type: DIRECTIVE_NODES.unknown, attrs: { name, info: token.info }, content: bodyOf(token, parseChildren) }
}

/** Registers the container syntax with the markdown reader. */
const DirectiveSyntax = Extension.create({
  name: 'markdownDirectiveSyntax',
  markdownTokenName: DIRECTIVE_TOKEN,
  markdownTokenizer: {
    name: DIRECTIVE_TOKEN,
    level: 'block',
    start: openingAt,
    tokenize: (src, _tokens, lexer) => tokenizeDirective(src, lexer),
  },
  parseMarkdown: (token, h) => directiveNode(token as DirectiveToken, h.parseChildren),
})

/**
 * How many directive blocks deep a node's contents go. A container's fence has
 * to be longer than every fence inside it, so this is what decides how many
 * colons it is written with.
 */
function directiveDepth(node: JSONContent): number {
  let depth = 0
  for (const child of node.content ?? []) {
    depth = Math.max(depth, (DIRECTIVE_NODE_NAMES.includes(child.type ?? '') ? 1 : 0) + directiveDepth(child))
  }
  return depth
}

/** A directive block as markdown: its fence and info line, its contents, its closing fence. */
function writeDirective(node: JSONContent, body: string, info: string): string {
  const fence = ':'.repeat(3 + directiveDepth(node))
  return `${fence}${info}\n${body}${body === '' ? '\n' : '\n\n'}${fence}`
}

function directiveName(element: HTMLElement): string {
  return element.getAttribute(DIRECTIVE_DOM.name) ?? ''
}

function isTabsElement(element: Element | null): boolean {
  if (!element || element.getAttribute(DIRECTIVE_DOM.name) !== TABS_DIRECTIVE) {
    return false
  }
  const children = [...element.children]
  return children.length > 0 && children.every((child) => child.getAttribute(DIRECTIVE_DOM.name) === TAB_DIRECTIVE)
}

/** The heading attribute every known block keeps. */
function headingAttribute() {
  return {
    default: '',
    parseHTML: (element: HTMLElement) => element.getAttribute(DIRECTIVE_DOM.heading) ?? '',
    renderHTML: (attributes: Record<string, unknown>) => ({ [DIRECTIVE_DOM.heading]: attributes.heading }),
  }
}

export const CalloutNode = Node.create({
  name: DIRECTIVE_NODES.callout,
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (element: HTMLElement) => directiveName(element),
        renderHTML: (attributes: Record<string, unknown>) => ({ [DIRECTIVE_DOM.name]: attributes.kind }),
      },
      heading: headingAttribute(),
    }
  },
  parseHTML() {
    return [
      {
        tag: `div[${DIRECTIVE_DOM.name}]`,
        getAttrs: (element) => (isCalloutKind(directiveName(element)) ? null : false),
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', HTMLAttributes, 0]
  },
  renderMarkdown: (node, h) =>
    writeDirective(
      node,
      h.renderChildren(node.content ?? [], '\n\n'),
      formatDirectiveInfo(node.attrs?.kind, node.attrs?.heading),
    ),
})

export const SpoilerNode = Node.create({
  name: DIRECTIVE_NODES.spoiler,
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { heading: headingAttribute() }
  },
  parseHTML() {
    return [
      {
        tag: `div[${DIRECTIVE_DOM.name}]`,
        getAttrs: (element) => (directiveName(element) === SPOILER_DIRECTIVE ? null : false),
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, [DIRECTIVE_DOM.name]: SPOILER_DIRECTIVE }, 0]
  },
  renderMarkdown: (node, h) =>
    writeDirective(
      node,
      h.renderChildren(node.content ?? [], '\n\n'),
      formatDirectiveInfo(SPOILER_DIRECTIVE, node.attrs?.heading),
    ),
})

export const TabsNode = Node.create({
  name: DIRECTIVE_NODES.tabs,
  group: 'block',
  content: `${DIRECTIVE_NODES.tab}+`,
  defining: true,
  parseHTML() {
    return [{ tag: `div[${DIRECTIVE_DOM.name}]`, getAttrs: (element) => (isTabsElement(element) ? null : false) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, [DIRECTIVE_DOM.name]: TABS_DIRECTIVE }, 0]
  },
  renderMarkdown: (node, h) => writeDirective(node, h.renderChildren(node.content ?? [], '\n\n'), TABS_DIRECTIVE),
})

export const TabNode = Node.create({
  name: DIRECTIVE_NODES.tab,
  content: 'block+',
  defining: true,
  addAttributes() {
    return { heading: headingAttribute() }
  },
  parseHTML() {
    return [
      {
        tag: `div[${DIRECTIVE_DOM.name}]`,
        getAttrs: (element) =>
          directiveName(element) === TAB_DIRECTIVE && isTabsElement(element.parentElement) ? null : false,
      },
    ]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, [DIRECTIVE_DOM.name]: TAB_DIRECTIVE }, 0]
  },
  renderMarkdown: (node, h) =>
    writeDirective(
      node,
      h.renderChildren(node.content ?? [], '\n\n'),
      formatDirectiveInfo(TAB_DIRECTIVE, node.attrs?.heading),
    ),
})

export const UnknownDirectiveNode = Node.create({
  name: DIRECTIVE_NODES.unknown,
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (element: HTMLElement) => directiveName(element),
        renderHTML: (attributes: Record<string, unknown>) => ({ [DIRECTIVE_DOM.name]: attributes.name }),
      },
      info: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute(DIRECTIVE_DOM.info) ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({ [DIRECTIVE_DOM.info]: attributes.info }),
      },
    }
  },
  parseHTML() {
    // Below every known block's rule, so it only takes what none of them claimed.
    return [{ tag: `div[${DIRECTIVE_DOM.name}]`, priority: 40 }]
  },
  renderHTML({ HTMLAttributes }) {
    // Its content is shown as plain content, in a dashed box headed by the
    // directive's name, so the author can see the block is there and which
    // one it is without the editor pretending to know what it means.
    return [
      'div',
      {
        ...HTMLAttributes,
        class:
          'my-2 rounded-md border border-dashed px-3 py-2 before:mb-1 before:block before:font-mono before:text-xs before:text-muted-foreground before:content-[attr(data-md-directive)]',
      },
      0,
    ]
  },
  renderMarkdown: (node, h) =>
    writeDirective(node, h.renderChildren(node.content ?? [], '\n\n'), `${node.attrs?.name}${node.attrs?.info}`),
})

/** The documentation blocks' syntax and schema, without their node views. */
export const directiveSchemaExtensions = [
  DirectiveSyntax,
  CalloutNode,
  SpoilerNode,
  TabsNode,
  TabNode,
  UnknownDirectiveNode,
]
