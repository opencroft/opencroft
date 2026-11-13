import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

import { fromElsewhere } from './markdown-doc-change'

/*
 * A document that starts with its title: the first block is always a level-1
 * heading. It can be emptied but not removed or turned into anything else --
 * a change made in this editor that leaves the document without it is
 * followed at once by one that puts it back: the first block made a level-1
 * heading again when it is a paragraph or a heading, an empty title put before
 * it otherwise.
 *
 * Only this editor's own changes are followed up. A shared document's changes
 * from elsewhere arrive through its binding (TipTap's `Collaboration`, whose
 * sync plugin marks them), and each editor answering them would put a title
 * back once per editor; the editor that made the change has already done it.
 * Loading a document the caller passed in is not followed up either, so
 * opening one writes nothing.
 */

const titlePlaceholderKey = new PluginKey('markdownEditorTitlePlaceholder')

/** What an empty title shows. */
export const TITLE_PLACEHOLDER = 'Title'

/** Whether `node` is a title: a level-1 heading. */
export function isTitle(node: ProseMirrorNode | null): boolean {
  return node?.type.name === 'heading' && node.attrs.level === 1
}

/** What puts the title back in `state`'s document, or null when it is there. */
function restoreTitle(state: EditorState): Transaction | null {
  const first = state.doc.firstChild
  if (isTitle(first)) {
    return null
  }
  const heading = state.schema.nodes.heading
  if (first && (first.type.name === 'paragraph' || first.type === heading)) {
    return state.tr.setNodeMarkup(0, heading, { ...first.attrs, level: 1 })
  }
  return state.tr.insert(0, heading.create({ level: 1 }))
}

export const TitleHeading = Extension.create({
  name: 'titleHeading',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          const own = transactions.some(
            (tr) => tr.docChanged && !tr.getMeta('preventUpdate') && !fromElsewhere(tr, oldState),
          )
          return own ? restoreTitle(newState) : null
        },
      }),
      // The empty title says what goes there, whether or not the caret is in
      // it; drawn by CSS from `data-placeholder`, as the editor's placeholder is.
      new Plugin({
        key: titlePlaceholderKey,
        props: {
          decorations: (state) => {
            const first = state.doc.firstChild
            if (!first || !isTitle(first) || first.content.size > 0) {
              return null
            }
            return DecorationSet.create(state.doc, [
              Decoration.node(0, first.nodeSize, { class: 'is-title-empty', 'data-placeholder': TITLE_PLACEHOLDER }),
            ])
          },
        },
      }),
    ]
  },
})
