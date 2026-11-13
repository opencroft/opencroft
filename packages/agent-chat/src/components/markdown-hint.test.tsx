// A rendered hint, mounted: a press on the content opens the note and a
// second one closes it, which is what a tap on a phone does; Escape closes it.
// Hover is the pointer primitive's own and is measured in a browser.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownHint: typeof import('./markdown-hint').MarkdownHint

before(async () => {
  container = installTestDom()
  // What the popup primitives reach for beyond the shared test DOM.
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownHint } = await import('./markdown-hint'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

async function mount() {
  root = createRoot(container)
  const next = root
  await act(async () =>
    next.render(
      <p>
        Ship <MarkdownHint text='Before the freeze'>today</MarkdownHint> please.
      </p>,
    ),
  )
}

// Asserted as booleans and strings, never as elements: printing a jsdom
// element walks the whole window and stalls the run.
const trigger = () => container.querySelector('[role="button"]') as HTMLElement | null
const noteShown = () => document.body.textContent?.includes('Before the freeze') ?? false

test('the note is not in the page until the content is pressed', async () => {
  await mount()
  assert.equal(trigger()?.textContent, 'today')
  assert.equal(noteShown(), false)
})

test('a press opens the note and a second press closes it', async () => {
  await mount()
  await act(async () => trigger()?.click())
  assert.equal(noteShown(), true)
  assert.equal(trigger()?.getAttribute('aria-expanded'), 'true')
  await act(async () => trigger()?.click())
  assert.equal(trigger()?.getAttribute('aria-expanded'), 'false')
})

test('Escape closes the note', async () => {
  await mount()
  await act(async () => trigger()?.click())
  await act(async () => {
    document.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.equal(trigger()?.getAttribute('aria-expanded'), 'false')
})
