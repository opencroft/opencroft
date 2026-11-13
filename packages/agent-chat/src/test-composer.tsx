import type { Editor } from '@tiptap/react'

import { installTestDom } from './test-dom'

/*
 * The chat composer under test: the test DOM with what its field reaches for
 * beyond it, and the reader's gestures on its text. Typing goes through the
 * editor's input handling a character at a time, and keys are dispatched on
 * the text, so the suggestion lists and the composer's own keys see them as
 * they see a keyboard's. A `.tsx` module, so a host's tests can import it
 * through the package (`agent-chat/test-composer`).
 */

/** Whether the main pointer is a finger. A desktop with a mouse unless a test says so. */
export const testPointer = { coarse: false }

/**
 * Adds to a jsdom window already installed as the globals what the composer's
 * field and its menus use and jsdom lacks or leaves on `window` alone.
 */
export function addComposerStubs(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of [
    'DOMParser',
    'getComputedStyle',
    'HTMLInputElement',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
    'DOMRect',
    'AbortController',
    'AbortSignal',
    'PointerEvent',
    'FocusEvent',
    'CompositionEvent',
  ]) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  globals.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  // jsdom lays nothing out: a Range has no boxes, and an element has no
  // scrolling to do.
  window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect()
  window.HTMLElement.prototype.scrollIntoView = () => {}
  // Nor does it animate: what a primitive waits on before it settles.
  window.Element.prototype.getAnimations = () => []
  // jsdom has no media queries.
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: coarse)' && testPointer.coarse,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
}

/** `installTestDom` with `addComposerStubs`. */
export function installComposerDom(): HTMLElement {
  const container = installTestDom()
  addComposerStubs()
  return container
}

/** The composer's editor inside `container`. */
export function composerEditor(container: ParentNode): Editor {
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null
  if (!dom?.editor) {
    throw new Error('no composer rendered')
  }
  return dom.editor
}

/** The composer's text, a line break as a newline. */
export function composerText(container: ParentNode): string {
  const { doc } = composerEditor(container).state
  return doc.textBetween(0, doc.content.size, '\n', '\n')
}

/** Where the caret is, as a count of characters into a one-line text. */
export function composerCaret(container: ParentNode): number {
  return composerEditor(container).state.selection.from - 1
}

/**
 * Lets the suggestion lists find their items, which they do asynchronously,
 * the editor take the focus it asks for, which it does on the next frame, and
 * React render what changed.
 */
export async function settle(): Promise<void> {
  const { act } = await import('react')
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => setTimeout(resolve, 0)))
  })
}

/**
 * Replaces the text with `text`, typed a character at a time, a newline as a
 * line break (Shift+Enter). The caret ends `caret` characters into a one-line
 * text, at the end unless given.
 */
export async function typeText(container: ParentNode, text: string, caret = text.length): Promise<void> {
  const { act } = await import('react')
  const editor = composerEditor(container)
  await act(async () => {
    editor.commands.focus()
    editor.commands.clearContent(true)
    for (const character of text) {
      if (character === '\n') {
        editor.commands.setHardBreak()
        continue
      }
      const { view } = editor
      const { from, to } = view.state.selection
      const handled = view.someProp('handleTextInput', (handle) =>
        handle(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
      )
      if (!handled) {
        view.dispatch(view.state.tr.insertText(character, from, to))
      }
    }
    if (caret !== text.length) {
      editor.commands.setTextSelection(1 + caret)
    }
  })
  await settle()
}

/** A key pressed in the text. */
export async function pressKey(container: ParentNode, key: string, init: KeyboardEventInit = {}): Promise<void> {
  const { act } = await import('react')
  const editor = composerEditor(container)
  await act(async () => {
    editor.view.dom.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
  await settle()
}
