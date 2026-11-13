'use client'

import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { MarkdownBlockMenu } from './markdown-block-menu'
import { type BlockInsert, matchBlockInserts } from './markdown-editor-block-inserts'
import {
  SUGGESTION_MENU_PRIORITY,
  type SuggestionMenuStore,
  suggestionMenuRender,
} from './markdown-editor-suggestion-menu'
import { inTable } from './markdown-editor-table-markdown'

/**
 * The `/` menu: typing `/` at the start of an empty line offers the blocks in
 * `BLOCK_INSERTS`, narrowed as the rest of the word is typed. Only on an empty
 * line, so a `/` in a sentence or a path is just a slash.
 */

export type SlashMenuStore = SuggestionMenuStore<BlockInsert>

export const SlashMenu = Extension.create<{ store: SlashMenuStore | null }>({
  name: 'markdownSlashMenu',
  priority: SUGGESTION_MENU_PRIORITY,
  addOptions() {
    return { store: null }
  },
  addProseMirrorPlugins() {
    const store = this.options.store
    if (!store) {
      return []
    }
    return [
      Suggestion<BlockInsert, BlockInsert>({
        editor: this.editor,
        pluginKey: new PluginKey('markdownSlashMenu'),
        char: '/',
        startOfLine: true,
        // The whole line is the `/` and what follows it, and nothing else. Never
        // in a table cell: a cell holds one line of text, so a block inserted
        // there could only be folded back into text.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          return (
            $from.parent.type.name === 'paragraph' &&
            $from.parent.textContent === state.doc.textBetween(range.from, range.to) &&
            !inTable($from)
          )
        },
        items: ({ query }) => matchBlockInserts(query),
        command: ({ editor, range, props }) => {
          props.insert(editor.chain().focus().deleteRange(range)).run()
        },
        render: suggestionMenuRender(store),
      }),
    ]
  },
})

/**
 * The open `/` menu, under the caret. In a portal, so an editor that scrolls
 * inside its own box cannot clip it.
 */
export function SlashMenuPopup({ store }: { store: SlashMenuStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, () => null)
  if (!state?.rect || state.items.length === 0) {
    return null
  }
  return createPortal(
    <div className='fixed z-50' style={{ top: state.rect.bottom + 4, left: state.rect.left }}>
      <MarkdownBlockMenu
        items={state.items}
        activeIndex={state.activeIndex}
        onSelect={(index) => state.choose(state.items[index])}
        onHover={(activeIndex) => store.set({ ...state, activeIndex })}
      />
    </div>,
    document.body,
  )
}
