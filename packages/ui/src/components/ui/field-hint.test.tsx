// A field hint, mounted: what opens it (a mouse resting on the label or the mark, a press on the
// mark), what never does (a press on the label, which keeps focusing its control), and what the
// hint shows.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
// What React, the popover and its positioning reach for.
const NAMES = [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
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
let FieldHint: typeof import('./field-hint').FieldHint
let FieldHintMarkdownProvider: typeof import('./field-hint').FieldHintMarkdownProvider
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
  ;({ createRoot } = await import('react-dom/client'))
  ;({ FieldHint, FieldHintMarkdownProvider } = await import('./field-hint'))
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
})

const TEXT = 'Keeps the **newest** events.'

async function mount(node: import('react').ReactNode) {
  const next = createRoot(container)
  root = next
  await React.act(async () => next.render(node))
}

function field(props: Partial<import('./field-hint').FieldHintProps> = {}) {
  return (
    <div>
      <FieldHint about='Limit per session' text={TEXT} {...props}>
        <label htmlFor='limit'>Limit per session</label>
      </FieldHint>
      <input id='limit' />
    </div>
  )
}

// Asserted as booleans and strings, never as elements: printing a jsdom element walks the whole
// window and stalls the run.
const mark = () => container.querySelector('button[aria-label="About Limit per session"]') as HTMLElement | null
const label = () => container.querySelector('label') as HTMLElement
const hintShown = () => document.body.textContent?.includes('events.') ?? false

async function hover(element: HTMLElement) {
  await React.act(async () => {
    for (const type of ['pointerenter', 'pointerover', 'pointermove']) {
      element.dispatchEvent(new window.PointerEvent(type, { bubbles: type !== 'pointerenter', pointerType: 'mouse' }))
    }
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
      element.dispatchEvent(new window.MouseEvent(type, { bubbles: type !== 'mouseenter' }))
    }
    // biome-ignore lint/plugin/noTestFixedTime: waits out the hover's open delay, which only a real timer passes
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

async function touchHover(element: HTMLElement) {
  await React.act(async () => {
    for (const type of ['pointerenter', 'pointerover', 'pointerdown']) {
      element.dispatchEvent(new window.PointerEvent(type, { bubbles: type !== 'pointerenter', pointerType: 'touch' }))
    }
    // What a touch screen sends after the tap, as if a mouse had come.
    for (const type of ['mouseenter', 'mouseover', 'mousemove']) {
      element.dispatchEvent(new window.MouseEvent(type, { bubbles: type !== 'mouseenter' }))
    }
    // biome-ignore lint/plugin/noTestFixedTime: a window longer than the hover's open delay in which nothing may open
    await new Promise((resolve) => setTimeout(resolve, 400))
  })
}

test('the hint is not in the page until it is opened', async () => {
  await mount(field())
  assert.equal(mark() !== null, true)
  assert.equal(hintShown(), false)
})

test('a press on the mark opens the hint and a second one closes it', async () => {
  await mount(field())
  await React.act(async () => mark()?.click())
  assert.equal(hintShown(), true)
  assert.equal(mark()?.getAttribute('aria-expanded'), 'true')
  await React.act(async () => mark()?.click())
  assert.equal(mark()?.getAttribute('aria-expanded'), 'false')
})

test('a mouse resting on the label opens the hint', async () => {
  await mount(field())
  await hover(label().parentElement as HTMLElement)
  assert.equal(hintShown(), true)
})

test('a mouse resting on the mark opens the hint', async () => {
  await mount(field())
  await hover(mark() as HTMLElement)
  assert.equal(hintShown(), true)
})

test('a touch on the label does not open the hint, whatever mouse events follow it', async () => {
  await mount(field())
  await touchHover(label().parentElement as HTMLElement)
  assert.equal(hintShown(), false)
})

test('a press on the label toggles its control and leaves the hint closed', async () => {
  await mount(
    <div>
      <FieldHint about='Limit per session' text={TEXT}>
        <label htmlFor='limit'>Limit per session</label>
      </FieldHint>
      <input id='limit' type='checkbox' />
    </div>,
  )
  const box = container.querySelector('input') as HTMLInputElement
  await React.act(async () => label().click())
  assert.equal(box.checked, true)
  assert.equal(hintShown(), false)
})

test('the label is no button: no role, no tab stop, no popup state', async () => {
  await mount(field())
  const wrapper = label().parentElement as HTMLElement
  assert.equal(wrapper.getAttribute('role'), null)
  assert.equal(wrapper.getAttribute('tabindex'), null)
  assert.equal(wrapper.getAttribute('aria-expanded'), null)
  assert.equal(container.querySelectorAll('[role="button"]').length, 0)
})

test('the hint shows its title, its tags and its text', async () => {
  await mount(field({ title: 'access_context_manager_custom_endpoint', tags: ['string', 'optional'] }))
  await React.act(async () => mark()?.click())
  const text = document.body.textContent ?? ''
  for (const part of ['access_context_manager_custom_endpoint', 'string', 'optional', TEXT]) {
    assert.equal(text.includes(part), true, part)
  }
})

test("the text goes through the host's markdown renderer", async () => {
  const Markdown = ({ text }: { text: string }) => <em data-rendered=''>{text.replaceAll('**', '')}</em>
  await mount(<FieldHintMarkdownProvider markdown={Markdown}>{field()}</FieldHintMarkdownProvider>)
  await React.act(async () => mark()?.click())
  assert.equal(document.querySelector('[data-rendered]')?.textContent, 'Keeps the newest events.')
})

test('with neither text nor tags it is the label alone', async () => {
  await mount(field({ text: undefined }))
  assert.equal(mark(), null)
  assert.equal(container.querySelector('[data-slot="field-hint"]'), null)
  assert.equal(label().textContent, 'Limit per session')
})
