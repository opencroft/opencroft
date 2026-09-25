'use client'

import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  Extension,
  Node,
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
} from '@tiptap/react'

import { MarkdownCallout, type MarkdownCalloutKind } from './components/markdown-callout'
import { isCalloutKind, SPOILER_DIRECTIVE, TAB_DIRECTIVE, TABS_DIRECTIVE } from './components/markdown-directives'
import { MarkdownSpoiler } from './components/markdown-spoiler'
import { MarkdownTabs } from './components/markdown-tabs'
import {
  DIRECTIVE_DOM,
  DIRECTIVE_NODES,
  type DirectiveSerializerState,
  formatDirectiveInfo,
  installDirectiveSyntax,
  writeDirective,
} from './markdown-editor-directives'

/*
 * The documentation blocks as editor content: a callout, a spoiler, tabs of
 * tabs, and a node for any directive the editor does not know, which keeps it
 * exactly as it was read so that opening and saving a page never rewrites or
 * loses a block added after this editor was written.
 *
 * Each node draws itself through the same component `Markdown` renders the
 * block with, in that component's editable form, so a block looks the same
 * being written as being read.
 */

function directiveName(element: HTMLElement): string {
  return element.getAttribute(DIRECTIVE_DOM.name) ?? ''
}

function isTabsElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement) || directiveName(element) !== TABS_DIRECTIVE) {
    return false
  }
  const children = [...element.children]
  return (
    children.length > 0 &&
    children.every((child) => child instanceof HTMLElement && directiveName(child) === TAB_DIRECTIVE)
  )
}

/** The heading attribute every known block keeps, read from and written to the parsed fence. */
function headingAttribute() {
  return {
    default: '',
    parseHTML: (element: HTMLElement) => element.getAttribute(DIRECTIVE_DOM.heading) ?? '',
    renderHTML: (attributes: Record<string, unknown>) => ({ [DIRECTIVE_DOM.heading]: attributes.heading }),
  }
}

function markdownStorage(info: (node: ProseMirrorNode) => string) {
  return {
    markdown: {
      serialize(state: DirectiveSerializerState, node: ProseMirrorNode) {
        writeDirective(state, node, info(node))
      },
      parse: {},
    },
  }
}

/* ─── Callout ─────────────────────────────────────────────────────────── */

function CalloutView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper>
      <MarkdownCallout
        kind={node.attrs.kind as MarkdownCalloutKind}
        title={node.attrs.heading as string}
        onTitleChange={(heading) => updateAttributes({ heading })}
        onKindChange={(kind) => updateAttributes({ kind })}
      >
        <NodeViewContent />
      </MarkdownCallout>
    </NodeViewWrapper>
  )
}

const CalloutNode = Node.create({
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
  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },
  addStorage() {
    return markdownStorage((node) => formatDirectiveInfo(node.attrs.kind, node.attrs.heading))
  },
})

/* ─── Spoiler ─────────────────────────────────────────────────────────── */

function SpoilerView({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper>
      <MarkdownSpoiler
        summary={node.attrs.heading as string}
        onSummaryChange={(heading) => updateAttributes({ heading })}
      >
        <NodeViewContent />
      </MarkdownSpoiler>
    </NodeViewWrapper>
  )
}

const SpoilerNode = Node.create({
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
  addNodeView() {
    return ReactNodeViewRenderer(SpoilerView)
  },
  addStorage() {
    return markdownStorage((node) => formatDirectiveInfo(SPOILER_DIRECTIVE, node.attrs.heading))
  },
})

/* ─── Tabs ────────────────────────────────────────────────────────────── */

/*
 * Which tab each tabs block shows is the editor's own state, not the
 * document's: it is not written to markdown, and a reader of the page always
 * starts on the first tab. It follows the caret -- putting the caret in a tab
 * selects it -- so choosing a tab in the strip is moving the caret into it,
 * and arrowing into a hidden tab brings it into view.
 */
interface ActiveTabs {
  /** Selected tab index by the tabs block's position. */
  active: Record<number, number>
  hidden: DecorationSet
}

const activeTabsKey = new PluginKey<ActiveTabs>('markdownEditorActiveTabs')

function followCaret(active: Record<number, number>, state: EditorState): Record<number, number> {
  const { $from } = state.selection
  const next = { ...active }
  for (let depth = $from.depth; depth > 1; depth--) {
    if ($from.node(depth).type.name === DIRECTIVE_NODES.tab) {
      next[$from.before(depth - 1)] = $from.index(depth - 1)
    }
  }
  return next
}

function shownTab(tabs: ProseMirrorNode, active: Record<number, number>, pos: number): number {
  return Math.min(active[pos] ?? 0, tabs.childCount - 1)
}

/** Which tab the tabs block at `pos` shows. */
export function activeTab(state: EditorState, pos: number): number {
  const tabs = state.doc.nodeAt(pos)
  const active = activeTabsKey.getState(state)?.active ?? {}
  return tabs ? shownTab(tabs, active, pos) : 0
}

function hiddenTabs(doc: ProseMirrorNode, active: Record<number, number>): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === DIRECTIVE_NODES.tabs) {
      const shown = shownTab(node, active, pos)
      node.forEach((tab, offset, index) => {
        if (index !== shown) {
          decorations.push(Decoration.node(pos + 1 + offset, pos + 1 + offset + tab.nodeSize, { class: 'hidden' }))
        }
      })
    }
    return true
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * Carry each remembered tab across a change. A document loaded in place of
 * the last one needs nothing special: its replacement maps every old position
 * to the end of the new content, where no tabs block starts, so each block in
 * it opens on its first tab.
 */
function mapActive(active: Record<number, number>, tr: Transaction): Record<number, number> {
  const next: Record<number, number> = {}
  for (const [pos, index] of Object.entries(active)) {
    const mapped = tr.mapping.mapResult(Number(pos))
    if (!mapped.deleted) {
      next[mapped.pos] = index
    }
  }
  return next
}

function sameActive(a: Record<number, number>, b: Record<number, number>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[Number(key)] === b[Number(key)])
}

const activeTabsPlugin = new Plugin<ActiveTabs>({
  key: activeTabsKey,
  state: {
    init: (_config, state) => ({ active: {}, hidden: hiddenTabs(state.doc, {}) }),
    apply: (tr, previous, _old, state) => {
      if (!tr.docChanged && !tr.selectionSet) {
        return previous
      }
      // Only a caret someone put somewhere is followed: a click, an arrow key,
      // a command that places it. One that merely rode along with a change --
      // loading leaves it at the end of the document, inside the last tab --
      // is not a place anyone chose.
      const mapped = mapActive(previous.active, tr)
      const active = tr.selectionSet ? followCaret(mapped, state) : mapped
      // A caret move that selects no other tab changes nothing on screen, and
      // rebuilding would walk the whole document on every arrow key.
      if (!tr.docChanged && sameActive(previous.active, active)) {
        return previous
      }
      return { active, hidden: hiddenTabs(state.doc, active) }
    },
  },
  props: {
    decorations: (state) => activeTabsKey.getState(state)?.hidden,
  },
})

/** The position of a tabs block's `index`-th tab. */
function tabPosition(tabs: ProseMirrorNode, tabsPos: number, index: number): number {
  let pos = tabsPos + 1
  for (let i = 0; i < index; i++) {
    pos += tabs.child(i).nodeSize
  }
  return pos
}

function TabsView({ node, editor, getPos }: NodeViewProps) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos()
      return typeof pos === 'number' ? activeTab(current.state, pos) : 0
    },
  })
  const tabs: { label: string }[] = []
  node.forEach((tab) => {
    tabs.push({ label: tab.attrs.heading as string })
  })

  const moveInto = (index: number) => {
    const pos = getPos()
    if (typeof pos === 'number') {
      const inside = tabPosition(node, pos, index) + 1
      editor
        .chain()
        .focus()
        .setTextSelection(TextSelection.near(editor.state.doc.resolve(inside)).from)
        .run()
    }
  }
  const add = () => {
    const pos = getPos()
    if (typeof pos !== 'number') {
      return
    }
    const { schema } = editor.state
    const tab = schema.nodes[DIRECTIVE_NODES.tab].create(
      { heading: `Tab ${node.childCount + 1}` },
      schema.nodes.paragraph.create(),
    )
    const end = pos + node.nodeSize - 1
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insert(end, tab)
        tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)))
        return true
      })
      .run()
  }
  const remove = (index: number) => {
    const pos = getPos()
    if (typeof pos !== 'number' || node.childCount < 2) {
      return
    }
    const from = tabPosition(node, pos, index)
    // The caret goes to the tab that takes this one's place -- the next one,
    // or the previous one when this was the last -- which also selects it.
    const neighbour = index < node.childCount - 1 ? from : from - node.child(index - 1).nodeSize
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.delete(from, from + node.child(index).nodeSize)
        tr.setSelection(TextSelection.near(tr.doc.resolve(neighbour + 1)))
        return true
      })
      .run()
  }
  const rename = (index: number, heading: string) => {
    const pos = getPos()
    if (typeof pos === 'number') {
      editor
        .chain()
        .command(({ tr }) => {
          tr.setNodeAttribute(tabPosition(node, pos, index), 'heading', heading)
          return true
        })
        .run()
    }
  }

  return (
    <NodeViewWrapper>
      <MarkdownTabs
        tabs={tabs}
        active={active}
        onActiveChange={moveInto}
        onAdd={add}
        onRename={rename}
        onRemove={remove}
        panel={<NodeViewContent />}
      />
    </NodeViewWrapper>
  )
}

const TabsNode = Node.create({
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
  addNodeView() {
    return ReactNodeViewRenderer(TabsView)
  },
  addProseMirrorPlugins() {
    return [activeTabsPlugin]
  },
  addStorage() {
    return markdownStorage(() => TABS_DIRECTIVE)
  },
})

const TabNode = Node.create({
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
  addStorage() {
    return markdownStorage((node) => formatDirectiveInfo(TAB_DIRECTIVE, node.attrs.heading))
  },
})

/* ─── Any other directive ─────────────────────────────────────────────── */

const UnknownDirectiveNode = Node.create({
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
  addStorage() {
    return markdownStorage((node) => `${node.attrs.name}${node.attrs.info}`)
  },
})

/** Registers the directive syntax with the editor's markdown parser. */
const DirectiveSyntax = Extension.create({
  name: 'markdownDirectiveSyntax',
  addStorage() {
    return { markdown: { parse: { setup: installDirectiveSyntax } } }
  },
})

/** Everything the editor needs to read, show, edit and write the documentation blocks. */
export const directiveBlockExtensions = [
  DirectiveSyntax,
  CalloutNode,
  SpoilerNode,
  TabsNode,
  TabNode,
  UnknownDirectiveNode,
]
