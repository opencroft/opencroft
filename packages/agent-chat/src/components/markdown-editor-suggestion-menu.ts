import type { SuggestionOptions } from '@tiptap/suggestion'

/**
 * What the editor's suggestion lists -- the `/` menu, the `@` list -- have in
 * common. A suggestion plugin owns when a list is open and what its query is;
 * the list itself is React. Between the two sits a small store, one per list
 * per editor, which the plugin writes and the popup reads.
 */

/**
 * A suggestion list's extension priority: ahead of every keymap, the
 * editor's own included, so a list on screen takes Enter, Tab, the arrows and
 * Escape before anything else reads them.
 */
export const SUGGESTION_MENU_PRIORITY = 1100

export interface SuggestionMenuState<T> {
  items: readonly T[]
  activeIndex: number
  /** Where the caret is on screen; the list opens under it. */
  rect: DOMRect | null
  choose: (item: T) => void
}

export interface SuggestionMenuStore<T> {
  get: () => SuggestionMenuState<T> | null
  set: (state: SuggestionMenuState<T> | null) => void
  subscribe: (listener: () => void) => () => void
}

export function createSuggestionMenuStore<T>(): SuggestionMenuStore<T> {
  let state: SuggestionMenuState<T> | null = null
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

function moveActive<T>(store: SuggestionMenuStore<T>, step: number) {
  const state = store.get()
  if (state && state.items.length > 0) {
    const count = state.items.length
    store.set({ ...state, activeIndex: (state.activeIndex + step + count) % count })
  }
}

/**
 * A suggestion plugin's `render`, reporting into `store`: arrows move through
 * the list, Enter or Tab chooses, Escape closes. With no items shown, every
 * key is the editor's own, so Enter still breaks the line.
 */
export function suggestionMenuRender<T>(store: SuggestionMenuStore<T>): NonNullable<SuggestionOptions<T, T>['render']> {
  return () => {
    const show = (props: {
      items: T[]
      clientRect?: (() => DOMRect | null) | null
      command: (item: T) => void
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
  }
}
