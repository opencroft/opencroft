'use client'

import { PluginKey } from '@tiptap/pm/state'
import { Extension } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { MarkdownBlockMenu } from './components/markdown-block-menu'
import { type BlockInsert, matchBlockInserts } from './markdown-editor-block-inserts'
import { inTable } from './markdown-editor-table-markdown'

/**
 * The `/` menu: typing `/` at the start of an empty line offers the blocks in
 * `BLOCK_INSERTS`, narrowed as the rest of the word is typed. Only on an empty
 * line, so a `/` in a sentence or a path is just a slash.
 *
 * The suggestion plugin owns when the menu is open and what the query is; the
 * menu itself is React, drawn by `SlashMenuPopup`. Between the two sits a
 * small store, one per editor, which the plugin writes and the popup reads.
 */

interface SlashMenuState {
  items: BlockInsert[]
  activeIndex: number
  /** Where the caret is on screen; the menu opens under it. */
  rect: DOMRect | null
  choose: (item: BlockInsert) => void
}

export interface SlashMenuStore {
  get: () => SlashMenuState | null
  set: (state: SlashMenuState | null) => void
  subscribe: (listener: () => void) => () => void
}

export function createSlashMenuStore(): SlashMenuStore {
  let state: SlashMenuState | null = null
  const listeners: (() => void)[] = []
  return {
    get: () => state,
    set: (next) => {
      state = next
      for (const listener of [...listeners]) {
        listener()
      }
    },
    subscribe: (listener) => {
      listeners.push(listener)
      return () => {
        listeners.splice(listeners.indexOf(listener), 1)
      }
    },
  }
}

function moveActive(store: SlashMenuStore, step: number) {
  const state = store.get()
  if (state && state.items.length > 0) {
    const count = state.items.length
    store.set({ ...state, activeIndex: (state.activeIndex + step + count) % count })
  }
}

export const SlashMenu = Extension.create<{ store: SlashMenuStore | null }>({
  name: 'markdownSlashMenu',
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
        render: () => {
          const show = (props: {
            items: BlockInsert[]
            clientRect?: (() => DOMRect | null) | null
            command: (item: BlockInsert) => void
          }) => {
            const previous = store.get()
            store.set({
              items: props.items,
              activeIndex: Math.min(previous?.activeIndex ?? 0, Math.max(props.items.length - 1, 0)),
              rect: props.clientRect?.() ?? null,
              choose: props.command,
            })
          }
          return {
            onStart: (props) => {
              store.set(null)
              show(props)
            },
            onUpdate: show,
            onExit: () => store.set(null),
            onKeyDown: ({ event }) => {
              const state = store.get()
              if (!state || state.items.length === 0) {
                return false
              }
              if (event.key === 'ArrowDown') {
                moveActive(store, 1)
                return true
              }
              if (event.key === 'ArrowUp') {
                moveActive(store, -1)
                return true
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                state.choose(state.items[state.activeIndex])
                return true
              }
              if (event.key === 'Escape') {
                store.set(null)
                return true
              }
              return false
            },
          }
        },
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
