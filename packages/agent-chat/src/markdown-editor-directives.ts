import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import container from 'markdown-it-container'

import { blockAttribute } from './components/markdown-directives'

/*
 * The documentation blocks' markdown syntax, as the editor reads and writes it.
 *
 * `Markdown` renders these through remark; the editor's markdown extension
 * parses with markdown-it instead, so the same syntax is read a second time
 * here. What each name MEANS -- which names are blocks, which attribute each
 * reads -- is not restated: it comes from `components/markdown-directives`.
 *
 * Parsing is markdown-it -> HTML -> the editor's schema. A container fence is
 * rendered as a `div` carrying the directive's name, its heading (the one
 * attribute the block reads, else its label) and the raw rest of its info
 * line, and each block node claims the `div`s that are its own. What no block
 * claims becomes the unknown-directive node, which writes its name and info
 * back exactly as read.
 */

type MarkdownIt = Parameters<typeof container>[0]

/** Node names of the directive blocks in the editor's schema. */
export const DIRECTIVE_NODES = {
  callout: 'markdownCallout',
  spoiler: 'markdownSpoiler',
  tabs: 'markdownTabs',
  tab: 'markdownTab',
  unknown: 'markdownDirective',
} as const

const DIRECTIVE_NODE_NAMES: readonly string[] = Object.values(DIRECTIVE_NODES)

/** The DOM attributes a parsed fence carries into the schema's parse rules. */
export const DIRECTIVE_DOM = {
  name: 'data-md-directive',
  heading: 'data-md-heading',
  info: 'data-md-info',
} as const

// Name, then an optional `[label]`, then optional `{attributes}`, as
// remark-directive reads a container's opening line.
const INFO = /^\s*([A-Za-z][\w-]*)(\[[^\]\n]*\])?(\{.*\})?\s*$/

const ATTRIBUTE = /([.#]?)([^\s"'={}.#]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]+)))?/g

/**
 * The value of one attribute in a `{...}` list, or undefined when the list
 * does not set it. Values are unescaped the way markdown-it unescapes any
 * text, so `&quot;` written by `formatDirectiveInfo` reads back as `"`.
 */
function readAttribute(list: string, wanted: string, md: MarkdownIt): string | undefined {
  for (const match of list.slice(1, -1).matchAll(ATTRIBUTE)) {
    const [, prefix, key, doubleQuoted, singleQuoted, bare] = match
    if (prefix === '' && key === wanted) {
      return md.utils.unescapeAll(doubleQuoted ?? singleQuoted ?? bare ?? '')
    }
  }
  return undefined
}

/** A label's text without its markup, as the renderer reads one. */
function labelText(label: string, md: MarkdownIt): string {
  const tokens = md.parseInline(label.slice(1, -1), {})
  return tokens
    .flatMap((token) => token.children ?? [])
    .filter((token) => token.type === 'text' || token.type === 'code_inline')
    .map((token) => token.content)
    .join('')
    .trim()
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

function renderOpening(info: string, md: MarkdownIt): string {
  const match = INFO.exec(info)
  if (!match) {
    return '<div>'
  }
  const [, name, label, attributes] = match
  const attribute = blockAttribute(name)
  const heading = attribute
    ? ((attributes ? readAttribute(attributes, attribute, md) : undefined) ?? (label ? labelText(label, md) : ''))
    : ''
  const html = md.utils.escapeHtml
  return (
    `<div ${DIRECTIVE_DOM.name}="${html(name)}" ${DIRECTIVE_DOM.heading}="${html(heading)}"` +
    ` ${DIRECTIVE_DOM.info}="${html((label ?? '') + (attributes ?? ''))}">`
  )
}

// The editor's markdown extension calls its parse setup on every parse, with
// the same markdown-it instance each time; registering the rule twice would
// run it twice.
const installed = new WeakSet<MarkdownIt>()

/** Teach a markdown-it instance container directives (`:::name[label]{attrs}`). */
export function installDirectiveSyntax(md: MarkdownIt) {
  if (installed.has(md)) {
    return
  }
  installed.add(md)
  md.use(container, 'directive', {
    marker: ':',
    validate: (params: string) => INFO.test(params),
    render: (tokens: { nesting: number; info: string }[], index: number) =>
      tokens[index].nesting === 1 ? renderOpening(tokens[index].info, md) : '</div>',
  })
}

/**
 * How many directive blocks deep a node's contents go. A container's fence has
 * to be longer than every fence inside it, so this is what decides how many
 * colons it is written with.
 */
function directiveDepth(node: ProseMirrorNode): number {
  let depth = 0
  node.forEach((child) => {
    depth = Math.max(depth, (DIRECTIVE_NODE_NAMES.includes(child.type.name) ? 1 : 0) + directiveDepth(child))
  })
  return depth
}

/** The part of the markdown serializer's state a directive block writes through. */
export interface DirectiveSerializerState {
  write(content?: string): void
  renderContent(node: ProseMirrorNode): void
  closeBlock(node: ProseMirrorNode): void
}

/** Write a directive block: its fence and info line, its contents, its closing fence. */
export function writeDirective(state: DirectiveSerializerState, node: ProseMirrorNode, info: string) {
  const fence = ':'.repeat(3 + directiveDepth(node))
  state.write(`${fence}${info}\n`)
  state.renderContent(node)
  state.write(fence)
  state.closeBlock(node)
}
