import { JSDOM } from 'jsdom'

/**
 * A DOM for tests that need one: the markdown editor parses through the DOM,
 * and a mounted component needs a document to render and re-render into.
 *
 * Call it before importing anything that reaches react-dom or TipTap, with
 * `await import(...)` after -- those modules bind to the globals present when
 * they are first evaluated, so a static import at the top of a test file would
 * capture the empty environment.
 */
export function installTestDom(): HTMLElement {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    // A real origin rather than jsdom's default `about:blank`, whose origin is
    // the string "null".
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = dom.window
  for (const name of [
    'document',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'DOMParser',
    'MutationObserver',
    'getComputedStyle',
    // An editor's `focus()` waits a frame before it scrolls the caret into view.
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
  ]) {
    globals[name] = (dom.window as unknown as Record<string, unknown>)[name]
  }
  // `navigator` is getter-only in Node, so plain assignment throws.
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  // Lets React accept `act()` for flushing work.
  globals.IS_REACT_ACT_ENVIRONMENT = true
  return dom.window.document.getElementById('root') as HTMLElement
}
