import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { Extension } from '@tiptap/react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  findReferences,
  getMarkdownReferences,
  type InlineReference,
  isBareLink,
  type MarkdownReferenceSource,
  matchUrlReference,
  subscribeMarkdownReferences,
} from './components/markdown-references'

/*
 * References inside the editor: the identifier stays exactly the text that is
 * stored, and only its styling changes -- the chip's look, and the thing's
 * mark before it. A click places the caret like anywhere else in the text;
 * opening a reference belongs to the rendered markdown, as it does for links
 * here (`openOnClick: false`).
 *
 * Typing rescans only the text blocks a transaction touched; everything else
 * keeps its decorations, mapped. Asking the host to resolve waits until the
 * typing pauses, so a key being typed out is not requested once per keystroke.
 */

const referencesKey = new PluginKey<DecorationSet>('markdownEditorReferences')

/** How long typing must pause before the references it produced are resolved. */
export const REFERENCE_REQUEST_DELAY_MS = 300

interface Found {
  from: number
  to: number
  reference: InlineReference
}

const isLink = (mark: Mark) => mark.type.name === 'link'
const isCode = (mark: Mark) => mark.type.name === 'code'

/** The references in one text block, in document positions. */
function scanBlock(block: ProseMirrorNode, pos: number, source: MarkdownReferenceSource): Found[] {
  if (block.type.spec.code) {
    return []
  }
  const found: Found[] = []
  block.forEach((child, offset) => {
    if (!child.isText || !child.text || child.marks.some(isCode)) {
      return
    }
    const start = pos + 1 + offset
    const link = child.marks.find(isLink)
    if (link) {
      const url = String(link.attrs.href ?? '')
      const bare = isBareLink({ type: 'link', url, children: [{ type: 'text', value: child.text }] })
      const kind = bare ? matchUrlReference(url, source.recognisers) : null
      if (kind) {
        found.push({ from: start, to: start + child.text.length, reference: { kind, id: url, trailing: false } })
      }
      return
    }
    for (const match of findReferences(child.text, source.recognisers)) {
      found.push({
        from: start + match.start,
        to: start + match.end,
        reference: { kind: match.kind, id: match.id, trailing: false },
      })
    }
  })
  return found
}

// Each icon is its own small React root, unmounted when ProseMirror drops the
// widget that holds it.
const iconRoots = new WeakMap<globalThis.Node, Root>()

function iconWidget(icon: ReactNode): HTMLElement {
  const dom = document.createElement('span')
  dom.contentEditable = 'false'
  const root = createRoot(dom)
  root.render(icon)
  iconRoots.set(dom, root)
  return dom
}

function destroyIconWidget(dom: globalThis.Node): void {
  const root = iconRoots.get(dom)
  iconRoots.delete(dom)
  // Deferred: ProseMirror can drop a widget while React is rendering the
  // editor, and a root may not be unmounted synchronously during a render.
  queueMicrotask(() => root?.unmount())
}

function decorationsFor(found: Found[], source: MarkdownReferenceSource): Decoration[] {
  const decorations: Decoration[] = []
  for (const { from, to, reference } of found) {
    const look = source.decorate?.(reference)
    if (!look) {
      continue
    }
    decorations.push(Decoration.inline(from, to, { class: look.className ?? '', ...look.attributes }, { reference }))
    if (look.icon) {
      const icon = look.icon
      decorations.push(
        Decoration.widget(from, () => iconWidget(icon), {
          side: -1,
          ignoreSelection: true,
          reference,
          // A widget with the same key is reused rather than redrawn, so an
          // icon only re-renders when what it shows could have changed.
          key: `${reference.kind}:${reference.id}:${look.className ?? ''}`,
          destroy: destroyIconWidget,
        }),
      )
    }
  }
  return decorations
}

function scanDocument(doc: ProseMirrorNode, source: MarkdownReferenceSource | null): Found[] {
  if (!source?.recognisers.length) {
    return []
  }
  const found: Found[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      found.push(...scanBlock(node, pos, source))
      return false
    }
    return true
  })
  return found
}

/** The text blocks a transaction changed, as [from, to] ranges in the new document. */
function changedBlocks(tr: Transaction): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  tr.mapping.maps.forEach((map, index) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      // Later steps move what this one changed.
      const rest = tr.mapping.slice(index + 1)
      ranges.push([rest.map(newStart, -1), rest.map(newEnd, 1)])
    })
  })
  const blocks: Array<[number, number]> = []
  for (const [from, to] of ranges) {
    tr.doc.nodesBetween(Math.max(0, from), Math.min(tr.doc.content.size, to), (node, pos) => {
      if (node.isTextblock) {
        if (!blocks.some(([start]) => start === pos)) {
          blocks.push([pos, pos + node.nodeSize])
        }
        return false
      }
      return true
    })
  }
  return blocks
}

function rescan(tr: Transaction, current: DecorationSet, source: MarkdownReferenceSource): DecorationSet {
  let next = current.map(tr.mapping, tr.doc)
  for (const [from, to] of changedBlocks(tr)) {
    next = next.remove(next.find(from, to))
    const block = tr.doc.nodeAt(from)
    if (block) {
      next = next.add(tr.doc, decorationsFor(scanBlock(block, from, source), source))
    }
  }
  return next
}

/** Every reference currently decorated, deduplicated. */
function decoratedReferences(set: DecorationSet): InlineReference[] {
  const seen: Record<string, InlineReference> = {}
  for (const decoration of set.find()) {
    const reference = (decoration.spec as { reference?: InlineReference }).reference
    if (reference) {
      seen[`${reference.kind}\n${reference.id}`] = reference
    }
  }
  return Object.values(seen)
}

export const MarkdownEditorReferences = Extension.create({
  name: 'markdownEditorReferences',
  addProseMirrorPlugins() {
    let timer: ReturnType<typeof setTimeout> | undefined
    const requestSoon = (view: EditorView) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const source = getMarkdownReferences()
        const set = referencesKey.getState(view.state)
        if (source?.request && set) {
          const references = decoratedReferences(set)
          if (references.length) {
            source.request(references)
          }
        }
      }, REFERENCE_REQUEST_DELAY_MS)
    }
    const rebuild = (doc: ProseMirrorNode) => {
      const source = getMarkdownReferences()
      return DecorationSet.create(doc, source ? decorationsFor(scanDocument(doc, source), source) : [])
    }
    return [
      new Plugin<DecorationSet>({
        key: referencesKey,
        state: {
          init: (_config, state) => rebuild(state.doc),
          apply: (tr, current) => {
            if (tr.getMeta(referencesKey)) {
              return rebuild(tr.doc)
            }
            const source = getMarkdownReferences()
            if (!tr.docChanged || !source?.recognisers.length) {
              return tr.docChanged ? current.map(tr.mapping, tr.doc) : current
            }
            return rescan(tr, current, source)
          },
        },
        props: {
          decorations: (state) => referencesKey.getState(state),
        },
        view: (view) => {
          const refresh = () => {
            if (!view.isDestroyed) {
              view.dispatch(view.state.tr.setMeta(referencesKey, true).setMeta('addToHistory', false))
            }
          }
          // A new source (recognisers arriving after the editor did) rebuilds
          // everything; what the host learns about references re-decorates.
          let unsubscribeSource = getMarkdownReferences()?.subscribe?.(refresh)
          const unsubscribeInstall = subscribeMarkdownReferences(() => {
            unsubscribeSource?.()
            unsubscribeSource = getMarkdownReferences()?.subscribe?.(refresh)
            refresh()
            requestSoon(view)
          })
          requestSoon(view)
          return {
            update: (updated, previous) => {
              if (updated.state.doc !== previous.doc) {
                requestSoon(updated)
              }
            },
            destroy: () => {
              clearTimeout(timer)
              unsubscribeSource?.()
              unsubscribeInstall()
            },
          }
        },
      }),
    ]
  },
})
