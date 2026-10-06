import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Awareness } from 'y-protocols/awareness'

import { absolutePosition, relativePosition } from '@/components/shared-markdown-editor/relative-position'

/*
 * Where a collaborator is while their focus is in a block's own controls -- a
 * callout's title, a spoiler's summary, a tab's label -- rather than in its
 * text. The caret binding follows only the text and announces no caret while
 * the focus is anywhere else, so without this a collaborator typing a title
 * would vanish from everyone else's screen. The block is announced in the
 * awareness state beside the caret, and every other editor marks it with the
 * collaborator's tag, tethered to the block by an anchor name. The tags are
 * kept beside the editor rather than among the blocks: an element there would
 * be laid out as one of them, taking the first block's place or holding apart
 * the margins of the blocks on either side, and the blocks would move.
 */

/** The awareness field naming the block whose controls hold a collaborator's focus. */
const BLOCK_FIELD = 'block'

const blockPresenceKey = new PluginKey<DecorationSet>('blockPresence')

/** A collaborator's tag, and the anchor name of the block it marks. */
interface Tag {
  anchor: string
  user: unknown
}

export interface BlockPresenceOptions {
  /** Shared with the other editors of the document. */
  awareness: Awareness | null
  /**
   * Draws a collaborator's tag from their awareness `user`, tethered to the
   * block named `anchor`; null draws nothing.
   */
  render: (user: unknown, anchor: string) => HTMLElement | null
}

let editors = 0

/**
 * The position of the innermost block whose own controls hold `element`, or
 * null when `element` is in the text or outside the editor.
 */
function blockHolding(view: EditorView, element: EventTarget | null): number | null {
  if (
    !(element instanceof HTMLElement) ||
    element === view.dom ||
    element.isContentEditable ||
    !view.dom.contains(element)
  ) {
    return null
  }
  // Inside a block's controls the view answers with the block's own edge: the
  // position before it, or the start of its content.
  const $pos = view.state.doc.resolve(view.posAtDOM(element, 0))
  const candidates = [$pos.pos]
  for (let depth = $pos.depth; depth > 0; depth--) {
    candidates.push($pos.before(depth))
  }
  return candidates.find((pos) => $pos.doc.nodeAt(pos)?.isBlock && view.nodeDOM(pos)?.contains(element)) ?? null
}

/**
 * An anchor name on each block another editor's controls focus is in, one per
 * collaborator there, prefixed with `prefix` to keep them apart from other
 * editors' on the page. The decoration carries the tags tethered to it, so a
 * tag goes when its block does.
 */
function presenceDecorations(state: EditorState, awareness: Awareness, prefix: string): DecorationSet {
  const blocks = new Map<number, Tag[]>()
  awareness.getStates().forEach((other, clientId) => {
    if (clientId === awareness.clientID || other?.[BLOCK_FIELD] == null) {
      return
    }
    const pos = absolutePosition(state, other[BLOCK_FIELD])
    if (pos !== null && state.doc.nodeAt(pos)?.isBlock) {
      blocks.set(pos, [...(blocks.get(pos) ?? []), { anchor: `${prefix}-${clientId}`, user: other.user }])
    }
  })
  const decorations = [...blocks].map(([pos, tags]) =>
    Decoration.node(
      pos,
      pos + (state.doc.nodeAt(pos)?.nodeSize ?? 0),
      { style: `anchor-name: ${tags.map((tag) => tag.anchor).join(', ')}` },
      { tags },
    ),
  )
  return DecorationSet.create(state.doc, decorations)
}

function blockPresencePlugin(awareness: Awareness, render: BlockPresenceOptions['render']): Plugin<DecorationSet> {
  editors += 1
  const prefix = `--block-presence-${editors}`
  return new Plugin<DecorationSet>({
    key: blockPresenceKey,
    state: {
      init: (_config, state) => presenceDecorations(state, awareness, prefix),
      // Redrawn when someone's focus moves and when a change from elsewhere
      // arrives, which is when a relative position may resolve differently;
      // this editor's own changes only move the anchors along.
      apply: (tr, previous, _old, state) =>
        tr.getMeta(blockPresenceKey) || isChangeOrigin(tr)
          ? presenceDecorations(state, awareness, prefix)
          : previous.map(tr.mapping, tr.doc),
    },
    props: {
      decorations: (state) => blockPresenceKey.getState(state),
    },
    view: (view) => {
      const layer = document.createElement('div')
      // No box of its own: the tags are positioned against their blocks.
      layer.style.display = 'contents'
      let drawn: string | null = null
      const draw = () => {
        // The editor's element may have been moved since the last draw.
        if (layer.previousSibling !== view.dom) {
          view.dom.after(layer)
        }
        const blocks = blockPresenceKey.getState(view.state)?.find() ?? []
        const tags: Tag[] = blocks.flatMap((decoration) => decoration.spec.tags)
        // Keyed by where the blocks are as well: a tag that moves to another
        // block is drawn afresh, since the browser keeps a tag in the place it
        // last fitted -- inside a block that had no room above it -- while that
        // place still fits.
        const next = JSON.stringify(blocks.map((decoration) => [decoration.from, decoration.spec.tags]))
        if (next !== drawn) {
          drawn = next
          layer.replaceChildren(...tags.flatMap((tag) => render(tag.user, tag.anchor) ?? []))
        }
      }
      let announced: string | null = null
      const announce = (focused: EventTarget | null) => {
        const block = blockHolding(view, focused)
        const field = block === null ? null : relativePosition(view.state, block)
        const next = field && JSON.stringify(field)
        if (next !== announced) {
          announced = next
          awareness.setLocalStateField(BLOCK_FIELD, field)
        }
      }
      const onFocusIn = (event: FocusEvent) => announce(event.target)
      // Where the focus is going: it may be another block's controls.
      const onFocusOut = (event: FocusEvent) => announce(event.relatedTarget)
      const onChange = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
        if ([...added, ...updated, ...removed].some((clientId) => clientId !== awareness.clientID)) {
          view.dispatch(view.state.tr.setMeta(blockPresenceKey, true))
        }
      }
      view.dom.addEventListener('focusin', onFocusIn)
      view.dom.addEventListener('focusout', onFocusOut)
      awareness.on('change', onChange)
      draw()
      return {
        update: () => {
          // A control removed while focused -- its block deleted, or undone --
          // takes the focus with it and fires no focusout.
          const page = view.dom.ownerDocument
          announce(page.hasFocus() ? page.activeElement : null)
          draw()
        },
        destroy: () => {
          view.dom.removeEventListener('focusin', onFocusIn)
          view.dom.removeEventListener('focusout', onFocusOut)
          awareness.off('change', onChange)
          awareness.setLocalStateField(BLOCK_FIELD, null)
          layer.remove()
        },
      }
    },
  })
}

/** Shows which block's controls each collaborator is in, and tells them which this editor's are. */
export const BlockPresence = Extension.create<BlockPresenceOptions>({
  name: 'blockPresence',

  addOptions() {
    return { awareness: null, render: () => null }
  },

  addProseMirrorPlugins() {
    const { awareness, render } = this.options
    return awareness ? [blockPresencePlugin(awareness, render)] : []
  },
})
