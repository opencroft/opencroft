'use client'

import { Extension } from '@tiptap/core'
import { PluginKey, TextSelection } from '@tiptap/pm/state'
import { Suggestion } from '@tiptap/suggestion'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'

import { type MentionCandidate, MentionAutocomplete } from './mention-autocomplete'
import {
  SUGGESTION_MENU_PRIORITY,
  type SuggestionMenuStore,
  suggestionMenuRender,
} from './markdown-editor-suggestion-menu'
import { getMarkdownMentions, type MarkdownMentionSource } from './markdown-mentions'

/**
 * The `@` list: typing `@` at the start of a line or after whitespace offers
 * whom the installed mention source finds for what follows it, and choosing
 * one writes `@<handle>` and a space. That is plain text, as the chat
 * composer writes it; the installed references draw it as a mention.
 *
 * As in the composer, the mention runs from the `@` to the caret, and the
 * `@` of an e-mail address opens nothing. Never in code or a link's text,
 * where a mention is not drawn as one. With no source installed, nothing
 * opens.
 */

export type MentionMenuStore = SuggestionMenuStore<MentionCandidate>

export const MentionMenu = Extension.create<{
  store: MentionMenuStore | null
  /** Whom to offer: the installed source unless one is given. */
  source: () => MarkdownMentionSource | null
}>({
  name: 'markdownMentionMenu',
  priority: SUGGESTION_MENU_PRIORITY,
  addOptions() {
    return { store: null, source: getMarkdownMentions }
  },
  addProseMirrorPlugins() {
    const { store, source } = this.options
    if (!store) {
      return []
    }
    return [
      Suggestion<MentionCandidate, MentionCandidate>({
        editor: this.editor,
        pluginKey: new PluginKey('markdownMentionMenu'),
        char: '@',
        // What may precede the `@` is decided in `allow`, against any
        // whitespace rather than a space alone.
        allowedPrefixes: null,
        allow: ({ state, range }) => {
          if (!source()) {
            return false
          }
          const $from = state.doc.resolve(range.from)
          // An inline node before the `@` (a line break, an icon) reads as a
          // line break here: it separates as whitespace does.
          const before = range.from > $from.start() ? state.doc.textBetween(range.from - 1, range.from, '\n', '\n') : ''
          const marks = state.doc.resolve(range.from + 1).marks()
          return (
            /^\s?$/.test(before) &&
            !$from.parent.type.spec.code &&
            !marks.some((mark) => mark.type.name === 'code' || mark.type.name === 'link')
          )
        },
        items: async ({ query, signal }) => [...((await source()?.search(query, signal)) ?? [])],
        command: ({ editor, range, props }) => {
          const text = `@${props.handle} `
          editor
            .chain()
            .focus()
            .command(({ tr }) => {
              // A space already after the caret is reused rather than doubled.
              const $to = tr.doc.resolve(range.to)
              const next = $to.parent.textBetween($to.parentOffset, Math.min($to.parentOffset + 1, $to.parent.content.size))
              const to = next === ' ' ? range.to + 1 : range.to
              tr.insertText(text, range.from, to)
              tr.setSelection(TextSelection.create(tr.doc, range.from + text.length))
              return true
            })
            .run()
        },
        render: suggestionMenuRender(store),
      }),
    ]
  },
})

// The list's width, `w-72`, for keeping it inside the window.
const LIST_WIDTH_PX = 288
const WINDOW_MARGIN_PX = 8

/**
 * The open `@` list, under the caret: the chat composer's mention popup,
 * opening downwards. In a portal, so an editor that scrolls inside its own
 * box cannot clip it, and moved left where the caret is too near the
 * window's right edge for it to fit.
 */
export function MentionMenuPopup({ store }: { store: MentionMenuStore }) {
  const state = useSyncExternalStore(store.subscribe, store.get, () => null)
  if (!state?.rect || state.items.length === 0) {
    return null
  }
  const left = Math.max(
    WINDOW_MARGIN_PX,
    Math.min(state.rect.left, window.innerWidth - LIST_WIDTH_PX - WINDOW_MARGIN_PX),
  )
  return createPortal(
    <div className='fixed z-50 w-72 max-w-[calc(100vw-1rem)]' style={{ top: state.rect.bottom, left }}>
      <MentionAutocomplete
        side='bottom'
        items={state.items}
        activeIndex={state.activeIndex}
        onSelect={state.choose}
        onHover={(activeIndex) => store.set({ ...state, activeIndex })}
      />
    </div>,
    document.body,
  )
}
