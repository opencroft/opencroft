// The multi-select, mounted: a press on the button opens the list, a row ticks
// or unticks its value and the list stays open, Clear empties the choice, a
// chosen value the options lack stays listed under its raw value, and the
// search narrows the rows.
// Width and the button's one line are a
// browser's to see, not this DOM's.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()
// What React, the popover, its positioning and the command list reach for.
const NAMES = [
  'window',
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'NodeFilter',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'KeyboardEvent',
  'InputEvent',
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
let MultiSelect: typeof import('./multi-select').MultiSelect
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
  // The command list scrolls its highlighted row into view; jsdom lays nothing out.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  globals.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MultiSelect } = await import('./multi-select'))
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

const AGENTS = [
  // Values unlike their labels, as a host keying by id has them.
  { value: 'id-17', label: 'Ada' },
  { value: 'id-23', label: 'Brook' },
  { value: 'id-42', label: 'Sage' },
]

/**
 * Mounts the select holding its own choice, as a host would, from `initial`.
 * Every choice handed out is pushed onto the returned list. `replaceOptions`
 * then hands the mounted select a different list, as a host whose period
 * moved on does.
 */
let replaceOptions: (next: typeof AGENTS) => void = () => {}

async function mount(initial: string[]) {
  const changes: string[][] = []
  function Host() {
    const [value, setValue] = React.useState(initial)
    const [options, setOptions] = React.useState(AGENTS)
    replaceOptions = setOptions
    return (
      <MultiSelect
        options={options}
        value={value}
        onValueChange={(next) => {
          changes.push(next)
          setValue(next)
        }}
        placeholder='All agents'
        summary={(n) => `${n} agents`}
        label='Agents'
      />
    )
  }
  const next = createRoot(container)
  root = next
  await React.act(async () => next.render(<Host />))
  return changes
}

// Asserted as booleans and strings, never as elements: printing a jsdom element walks the whole
// window and stalls the run.
const button = () => container.querySelector('button[role="combobox"]') as HTMLElement
const rows = () => [...dom.window.document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')]
const row = (text: string) => rows().find((each) => each.textContent === text)
const ticked = () =>
  rows()
    .filter((each) => each.getAttribute('aria-checked') === 'true')
    .map((each) => each.textContent)
const clear = () =>
  [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((each) => each.textContent === 'Clear')

async function open() {
  await React.act(async () => button().click())
}

test('the button opens a list of the options, the chosen ones ticked', async () => {
  await mount(['id-23'])
  assert.equal(button().getAttribute('aria-expanded'), 'false')
  await open()
  assert.equal(button().getAttribute('aria-expanded'), 'true')
  assert.deepEqual(
    rows().map((each) => each.textContent),
    ['Ada', 'Brook', 'Sage'],
  )
  assert.deepEqual(ticked(), ['Brook'])
})

test('a row ticks its value onto the choice and unticks it, and the list stays open', async () => {
  const changes = await mount(['id-23'])
  await open()
  await React.act(async () => row('Sage')?.click())
  await React.act(async () => row('Brook')?.click())
  assert.deepEqual(changes, [['id-23', 'id-42'], ['id-42']])
  assert.equal(button().getAttribute('aria-expanded'), 'true')
  assert.deepEqual(ticked(), ['Sage'])
  assert.equal(button().textContent, 'Sage')
})

test('the button reads the placeholder, the one label, or the count', async () => {
  await mount([])
  assert.equal(button().textContent, 'All agents')
  await open()
  await React.act(async () => row('Ada')?.click())
  assert.equal(button().textContent, 'Ada')
  await React.act(async () => row('Sage')?.click())
  assert.equal(button().textContent, '2 agents')
  assert.equal(button().getAttribute('aria-label'), 'Agents: 2 agents')
})

test('Clear empties the choice, and does nothing to offer with nothing chosen', async () => {
  const changes = await mount(['id-17', 'id-42'])
  await open()
  await React.act(async () => clear()?.click())
  assert.deepEqual(changes, [[]])
  assert.equal(clear()?.disabled, true)
  assert.equal(button().textContent, 'All agents')
})

test('a chosen value the options lack stays listed, ticked, and can be unticked', async () => {
  const changes = await mount(['gone'])
  await open()
  assert.deepEqual(
    rows().map((each) => each.textContent),
    ['Ada', 'Brook', 'Sage', 'gone'],
  )
  assert.deepEqual(ticked(), ['gone'])
  await React.act(async () => row('gone')?.click())
  assert.deepEqual(changes, [[]])
})

test('a chosen value whose option goes is named by its raw value, not the label it had', async () => {
  await mount(['id-42'])
  assert.equal(button().textContent, 'Sage')
  await React.act(async () => replaceOptions(AGENTS.slice(0, 2)))
  assert.equal(button().textContent, 'id-42')
  await open()
  assert.deepEqual(
    rows().map((each) => each.textContent),
    ['Ada', 'Brook', 'id-42'],
  )
  assert.deepEqual(ticked(), ['id-42'])
})

test('the search narrows the rows by label, never by the value behind it', async () => {
  await mount([])
  await open()
  const search = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')
  assert.ok(search, 'the list has a search field')
  const type = async (text: string) =>
    React.act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      setValue?.call(search, text)
      search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  await type('bro')
  assert.deepEqual(
    rows().map((each) => each.textContent),
    ['Brook'],
  )
  await type('id-2')
  assert.deepEqual(
    rows().map((each) => each.textContent),
    [],
    "a fragment of Brook's id finds nothing",
  )
})
