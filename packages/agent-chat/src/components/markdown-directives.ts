import type { Parent, Root, RootContent } from 'mdast'
import type { ContainerDirective, TextDirective } from 'mdast-util-directive'

import { MARKDOWN_CALLOUT_KINDS, type MarkdownCalloutKind } from './markdown-callout-kinds'
import { isMarkdownGridLayout, markdownGridBlockCount } from './markdown-grid-layouts'

/**
 * The documentation blocks markdown can carry, written as generic directives
 * (`remark-directive`, the syntax Docusaurus, VitePress and MyST share):
 *
 *     :::warning{title="Before you upgrade"}
 *     Back up the database first.
 *     :::
 *
 *     :::details{summary="Full log"}
 *     ...
 *     :::
 *
 *     ::::tabs
 *     :::tab{label="npm"}
 *     ...
 *     :::
 *     :::tab{label="pnpm"}
 *     ...
 *     :::
 *     ::::
 *
 *     ::::grid{layout=1/3+2/3}
 *     :::col
 *     ...
 *     :::
 *     :::col
 *     ...
 *     :::
 *     ::::
 *
 * and two inline elements: an icon in the text, named by its label and
 * coloured by a theme token, and a hint, a note shown over the content its
 * label holds, which can be any inline content, formatted, icons included:
 *
 *     Ship it :icon[rocket]{color=primary} today.
 *     Ship it :hint[**today**]{text="Before the freeze"}.
 *
 * This is the one place that says which directive names mean something and
 * which attribute each one reads (the callout kinds, the grid layouts and the
 * icon colours themselves are their components'), so anything else that reads or writes
 * these takes the names from here rather than restating them.
 */
export const SPOILER_DIRECTIVE = 'details'
export const TABS_DIRECTIVE = 'tabs'
export const TAB_DIRECTIVE = 'tab'
export const GRID_DIRECTIVE = 'grid'
export const COLUMN_DIRECTIVE = 'col'
export const ICON_DIRECTIVE = 'icon'
/** The one attribute an icon reads. */
export const ICON_COLOR_ATTRIBUTE = 'color'
export const HINT_DIRECTIVE = 'hint'
/** The one attribute a hint reads: the note it shows. */
export const HINT_TEXT_ATTRIBUTE = 'text'

/**
 * The element names the blocks are handed to the renderer under. Custom names
 * rather than `div`s with a marker, so a renderer claims exactly these and no
 * other element changes meaning.
 */
export const DIRECTIVE_ELEMENTS = {
  callout: 'markdown-callout',
  spoiler: 'markdown-spoiler',
  tabs: 'markdown-tabs',
  tab: 'markdown-tab',
  grid: 'markdown-grid',
  column: 'markdown-grid-column',
  icon: 'markdown-icon',
  hint: 'markdown-hint',
} as const

export function isCalloutKind(name: string): name is MarkdownCalloutKind {
  return (MARKDOWN_CALLOUT_KINDS as readonly string[]).includes(name)
}

/**
 * The one attribute a block reads, by directive name, or undefined for a
 * block that reads none. A directive's label -- `:::note[Heads up]`, the form
 * Docusaurus writes titles in -- stands in for it when the attribute is
 * absent.
 */
export function blockAttribute(name: string): 'title' | 'summary' | 'label' | 'layout' | undefined {
  if (isCalloutKind(name)) {
    return 'title'
  }
  if (name === SPOILER_DIRECTIVE) {
    return 'summary'
  }
  if (name === TAB_DIRECTIVE) {
    return 'label'
  }
  if (name === GRID_DIRECTIVE) {
    return 'layout'
  }
  return undefined
}

function textOf(node: RootContent): string {
  if ('value' in node) {
    return node.value
  }
  return 'children' in node ? node.children.map(textOf).join('') : ''
}

/** The paragraph remark-directive makes of a block's `[label]`, the block's first child. */
function labelOf(node: ContainerDirective): RootContent | undefined {
  const first = node.children[0]
  return first?.type === 'paragraph' && first.data?.directiveLabel ? first : undefined
}

/** What a block's heading says, read without changing the block: its attribute, else its label as plain text. */
function headingValue(node: ContainerDirective, name: string): string | undefined {
  const value = node.attributes?.[name]
  if (typeof value === 'string' && value !== '') {
    return value
  }
  const label = labelOf(node)
  const text = label ? textOf(label).trim() : ''
  return text === '' ? undefined : text
}

/**
 * What a block's heading says. The label is taken out of the body either way
 * -- it is the heading's, and left in place it would show as a stray first
 * paragraph.
 */
function headingOf(node: ContainerDirective, name: string): string | undefined {
  const heading = headingValue(node, name)
  if (labelOf(node)) {
    node.children.shift()
  }
  return heading
}

/**
 * Only the one attribute a block reads is carried to the rendered element,
 * never the author's attribute list as a whole. The attributes come from
 * whoever wrote the markdown -- an agent, a pasted page -- and passing them
 * through would let `{style="..."}` or an event-handler name reach the DOM.
 */
function claim(node: ContainerDirective, element: string, properties: Record<string, string | undefined> = {}) {
  node.data = { ...node.data, hName: element, hProperties: properties }
}

/** Blocks of one name and nothing else, the shape tabs and grids hold. */
function allNamed(children: readonly RootContent[], name: string): boolean {
  return children.length > 0 && children.every((child) => child.type === 'containerDirective' && child.name === name)
}

/**
 * A grid naming one of the grid's layouts, holding a column for each block the
 * layout has and nothing else. Its label, when the layout is written as one,
 * is not one of its blocks.
 */
function isLaidOutGrid(node: ContainerDirective): boolean {
  const layout = headingValue(node, 'layout')
  const blocks = labelOf(node) ? node.children.slice(1) : node.children
  return (
    isMarkdownGridLayout(layout) &&
    blocks.length === markdownGridBlockCount(layout) &&
    allNamed(blocks, COLUMN_DIRECTIVE)
  )
}

function claimedAs(parent: Parent, element: string): boolean {
  return parent.type === 'containerDirective' && parent.data?.hName === element
}

/**
 * A container nobody claims renders as its content in a plain box, with none
 * of its attributes: an unknown block name reads as ordinary text rather than
 * as raw `:::` or an error, which is what makes adding blocks later safe.
 */
function plain(node: ContainerDirective) {
  claim(node, 'div')
}

function transformContainer(node: ContainerDirective, parent: Parent) {
  if (isCalloutKind(node.name)) {
    claim(node, DIRECTIVE_ELEMENTS.callout, { kind: node.name, title: headingOf(node, 'title') })
  } else if (node.name === SPOILER_DIRECTIVE) {
    claim(node, DIRECTIVE_ELEMENTS.spoiler, { summary: headingOf(node, 'summary') })
  } else if (node.name === TABS_DIRECTIVE && allNamed(node.children, TAB_DIRECTIVE)) {
    claim(node, DIRECTIVE_ELEMENTS.tabs)
  } else if (node.name === TAB_DIRECTIVE && claimedAs(parent, DIRECTIVE_ELEMENTS.tabs)) {
    claim(node, DIRECTIVE_ELEMENTS.tab, { label: headingOf(node, 'label') })
  } else if (node.name === GRID_DIRECTIVE && isLaidOutGrid(node)) {
    claim(node, DIRECTIVE_ELEMENTS.grid, { layout: headingOf(node, 'layout') })
  } else if (node.name === COLUMN_DIRECTIVE && claimedAs(parent, DIRECTIVE_ELEMENTS.grid)) {
    claim(node, DIRECTIVE_ELEMENTS.column)
  } else {
    // Includes a `tabs` holding anything besides tabs, a `grid` whose layout
    // is not one of the grid's or does not match its columns, and a `tab` or
    // `col` outside one: shown as their content, so nothing the author wrote
    // is dropped.
    plain(node)
  }
}

/**
 * The source text a node was parsed from, exactly as written.
 */
function sourceOf(node: RootContent, source: string): string | undefined {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? undefined : source.slice(start, end)
}

/**
 * An icon: the text form named `icon` with a non-empty label, which is the
 * icon's name. Its label is the name and not text to show, so it leaves the
 * tree; the colour is carried as written, and the renderer decides whether it
 * is one it draws.
 */
function iconOf(node: RootContent): TextDirective | undefined {
  if (node.type !== 'textDirective' || node.name !== ICON_DIRECTIVE) {
    return undefined
  }
  return textOf(node).trim() === '' ? undefined : node
}

function claimIcon(node: TextDirective) {
  const color = node.attributes?.[ICON_COLOR_ATTRIBUTE]
  node.data = {
    ...node.data,
    hName: DIRECTIVE_ELEMENTS.icon,
    hProperties: { name: textOf(node).trim(), color: color ?? undefined },
  }
  node.children = []
}

/**
 * A hint: the text form named `hint`. Its label is the content it sits on and
 * stays in the tree; only the note is carried as a property. A hint with no
 * note, or nothing to sit on, is its content alone.
 */
function transformHint(node: TextDirective, source: string): RootContent[] {
  walk(node, source)
  const text = node.attributes?.[HINT_TEXT_ATTRIBUTE]?.trim()
  if (!text || node.children.length === 0) {
    return node.children
  }
  node.data = { ...node.data, hName: DIRECTIVE_ELEMENTS.hint, hProperties: { text } }
  return [node]
}

function walk(parent: Parent, source: string) {
  parent.children = parent.children.flatMap((child): RootContent[] => {
    if (child.type === 'containerDirective') {
      transformContainer(child, parent)
      walk(child, source)
      return [child]
    }
    const icon = iconOf(child)
    if (icon) {
      claimIcon(icon)
      return [icon]
    }
    if (child.type === 'textDirective' && child.name === HINT_DIRECTIVE) {
      return transformHint(child, source)
    }
    // Containers are blocks, and the icon and the hint are the text forms that mean
    // something. Any other text form (`:name`) turns up in ordinary prose --
    // `see file:README`, `key:value` -- so it goes back to the text it was
    // parsed from rather than swallowing what the author typed. No block uses
    // the leaf form (`::name` alone on a line) either, and it gets the same
    // treatment.
    if (child.type === 'textDirective' || child.type === 'leafDirective') {
      const text = sourceOf(child, source)
      if (text === undefined) {
        walk(child, source)
        return [child]
      }
      return [
        child.type === 'leafDirective'
          ? { type: 'paragraph', children: [{ type: 'text', value: text }] }
          : { type: 'text', value: text },
      ]
    }
    if ('children' in child) {
      walk(child, source)
    }
    return [child]
  }) as typeof parent.children
}

/**
 * A remark plugin, run after `remark-directive`: turns the documentation
 * blocks, icons and hints into the elements a renderer draws, and every other directive back
 * into ordinary content.
 */
export function remarkDirectiveBlocks() {
  return (tree: Root, file: { value: unknown }) => {
    walk(tree, String(file.value))
  }
}
