// A tool's kept picture in a live document: the size it is drawn at in the
// transcript's preview and in the dialog that shows the call in full, and a
// server-rendered picture that already failed to load before React took the
// page over. Layout itself is not measured here (the document has none); what
// is pinned is the width each place asks for and which element is drawn.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import type { ToolOutputPart } from 'agent-chat/tool-views'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
// What React and the dialog reach for.
const NAMES = [
  'window',
  'document',
  'HTMLElement',
  'HTMLImageElement',
  'Element',
  'Node',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'KeyboardEvent',
  'Event',
  'DOMRect',
  'AbortController',
  'AbortSignal',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]

let React: typeof import('react')
let createRoot: typeof import('react-dom/client').createRoot
let hydrateRoot: typeof import('react-dom/client').hydrateRoot
let renderToString: typeof import('react-dom/server').renderToString
let GenericToolView: typeof import('./run-views').GenericToolView
let ToolViewHostProvider: typeof import('./tool-view-host').ToolViewHostProvider
let root: import('react-dom/client').Root | null = null
let container: HTMLElement

before(async () => {
  for (const name of [...NAMES, 'navigator', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  for (const name of NAMES) {
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globals.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  ;({ createRoot, hydrateRoot } = await import('react-dom/client'))
  ;({ renderToString } = await import('react-dom/server'))
  ;({ GenericToolView } = await import('./run-views'))
  ;({ ToolViewHostProvider } = await import('./tool-view-host'))
  container = dom.window.document.getElementById('root') as HTMLElement
})

after(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete globals[name]
    }
  }
  dom.window.close()
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await React.act(async () => current.unmount())
  }
  container.innerHTML = ''
})

const host = {
  readFile: async () => '',
  readSkill: async () => '',
  describeBackgroundRun: () => undefined,
}

const TALL: ToolOutputPart = {
  type: 'image',
  mimeType: 'image/png',
  byteSize: 1299,
  src: '/media/tall?key=k',
  width: 120,
  height: 600,
}

function Call({ content }: { content: ToolOutputPart[] }) {
  return (
    <ToolViewHostProvider host={host}>
      <GenericToolView tool='view_image' args={{}} result={{ text: 'PNG', content }} state='completed' />
    </ToolViewHostProvider>
  )
}

test('a tall picture is drawn narrow enough to fit the preview, and at its own size in the dialog that shows it in full', async () => {
  const next = createRoot(container)
  root = next
  await React.act(async () => next.render(<Call content={[TALL]} />))
  const preview = container.querySelector('img')
  assert.ok(preview)
  // 256 px tall at 120:600 is 51 px wide; stretched across the card it would
  // frame the picture in an empty border.
  assert.equal(preview.style.width, '51px')
  assert.ok(preview.classList.contains('self-start'), preview.className)

  const card = container.querySelector('[role="button"][aria-label^="Show all of"]')
  assert.ok(card)
  await React.act(async () => {
    card.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
  const dialog = dom.window.document.querySelector('[role="dialog"]')
  assert.ok(dialog, 'pressing the card opens the dialog')
  const full = dialog.querySelector('img')
  assert.ok(full)
  assert.equal(full.style.width, '120px')
  assert.equal(full.style.maxHeight, '')
})

test('a picture whose bytes are gone before the page is interactive is drawn as the line, and a loading one stays a picture', async () => {
  const released: ToolOutputPart = { ...TALL, src: '/media/released?key=k' }
  container.innerHTML = renderToString(<Call content={[released, TALL]} />)
  const [gone, loading] = Array.from(container.querySelectorAll('img'))
  assert.ok(gone && loading)
  // As a browser leaves them: the released one answered 404 and fired its
  // error before React was there to hear it; the other is still loading.
  Object.defineProperties(gone, { complete: { value: true }, naturalWidth: { value: 0 } })
  Object.defineProperties(loading, { complete: { value: false }, naturalWidth: { value: 0 } })

  await React.act(async () => {
    root = hydrateRoot(container, <Call content={[released, TALL]} />)
  })
  assert.ok(container.textContent?.includes('image/png, 1 KB, no longer kept'), container.innerHTML)
  const pictures = Array.from(container.querySelectorAll('img'))
  assert.equal(pictures.length, 1)
  assert.equal(pictures[0].getAttribute('src'), '/media/tall?key=k')
})
