// What a value field on a node's card commits, and when: text and numbers on
// Enter or when the field loses focus, a toggle and a choice as they change,
// nothing while the input is wired. Mounted in a DOM rather than rendered to
// markup, because what is checked is the keys, focus and the commits they make.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

import type { NodeValue, NodeValueInputProps } from './node-value-input'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  const names = [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'DOMRect',
    'AbortController',
    'AbortSignal',
  ]
  for (const name of [...names, 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globals.IS_REACT_ACT_ENVIRONMENT = true
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

let unmount: (() => Promise<void>) | null = null

afterEach(async () => {
  await unmount?.()
  unmount = null
})

// Imported after the DOM exists: react-dom binds to the globals it finds when
// first loaded. The host holds the value in state, as a node's data would.
async function mount(props: Omit<NodeValueInputProps, 'label' | 'onCommit'>) {
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { NodeValueInput } = await import('./node-value-input')

  const commits: NodeValue[] = []
  let setWired: (wired: boolean) => void = () => {}

  function Host() {
    const [value, setValue] = useState(props.value)
    const [wired, setWiredState] = useState(props.wired)
    setWired = setWiredState
    return createElement(NodeValueInput, {
      ...props,
      label: 'Width',
      value,
      wired,
      onCommit: (next: NodeValue) => {
        commits.push(next)
        setValue(next)
      },
    })
  }

  const container = dom.window.document.getElementById('root')
  assert.ok(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(Host)))
  unmount = async () => act(async () => root.unmount())

  const field = () => {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Width"]')
    assert.ok(input, 'the field is there')
    return input
  }

  return {
    commits,
    field,
    container,
    // What a person's typing does: focus, the element's own value setter, then
    // the input event React listens for.
    type: (text: string) =>
      act(async () => {
        const input = field()
        input.focus()
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, text)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
    press: (key: string) =>
      act(async () => {
        field().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }),
    blur: () => act(async () => field().blur()),
    wire: () => act(async () => setWired(true)),
    focusOut: () =>
      act(async () => {
        field().dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }))
      }),
    click: (element: Element) =>
      act(async () => {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
          element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }))
        }
        ;(element as HTMLElement).click()
      }),
  }
}

test('Enter commits the typed text and leaves the field', async () => {
  const t = await mount({ kind: 'text', value: 'draft' })
  await t.type('final')
  await t.press('Enter')

  assert.deepEqual(t.commits, ['final'])
  assert.notEqual(dom.window.document.activeElement, t.field())
})

test('leaving the field commits the typed text', async () => {
  const t = await mount({ kind: 'text', value: 'draft' })
  await t.type('final')
  await t.blur()

  assert.deepEqual(t.commits, ['final'])
})

test('Escape after typing commits nothing and shows the value again', async () => {
  const t = await mount({ kind: 'text', value: 'draft' })
  await t.type('discarded')
  await t.press('Escape')

  assert.deepEqual(t.commits, [])
  assert.equal(t.field().value, 'draft')
  assert.notEqual(dom.window.document.activeElement, t.field())
})

test('Escape in a number field commits nothing and shows the number again', async () => {
  const t = await mount({ kind: 'number', value: 4 })
  await t.type('12')
  await t.press('Escape')

  assert.deepEqual(t.commits, [])
  assert.equal(t.field().value, '4')
})

test('text that is not a number puts the number field back', async () => {
  const t = await mount({ kind: 'number', value: 4 })
  await t.type('four')
  await t.blur()

  assert.deepEqual(t.commits, [])
  assert.equal(t.field().value, '4')
})

test('a whole-number field commits the typed number rounded', async () => {
  const t = await mount({ kind: 'number', value: 4, integer: true })
  await t.type('2.6')
  await t.blur()

  assert.deepEqual(t.commits, [3])
  assert.equal(t.field().value, '3')
})

test('a number above max commits max, and one below min commits min', async () => {
  const t = await mount({ kind: 'number', value: 4, min: 1, max: 10 })
  await t.type('50')
  await t.blur()
  await t.type('-3')
  await t.blur()

  assert.deepEqual(t.commits, [10, 1])
})

test('a toggle commits as it changes', async () => {
  const t = await mount({ kind: 'boolean', value: false })
  const toggle = t.container.querySelector('[role="switch"]')
  assert.ok(toggle, 'the toggle is there')
  await t.click(toggle)

  assert.deepEqual(t.commits, [true])
})

test('a choice from the dropdown commits as it is chosen, closes it, and shows its label', async () => {
  const t = await mount({
    kind: 'text',
    value: 'fast',
    options: [
      { value: 'fast', label: 'Fast' },
      { value: 'exact', label: 'Exact' },
    ],
  })
  const trigger = t.container.querySelector('[aria-label="Width"]')
  assert.ok(trigger, 'the dropdown is there')
  const shownLabel = () => trigger.querySelector('[data-slot="select-value"]')?.textContent
  assert.equal(shownLabel(), 'Fast')
  await t.click(trigger)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  const choice = [...dom.window.document.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent === 'Exact',
  )
  assert.ok(choice, 'the dropdown shows the choices')
  await t.click(choice)

  assert.deepEqual(t.commits, ['exact'])
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  assert.equal(shownLabel(), 'Exact')
})

test('a wired field is disabled and commits nothing', async () => {
  const t = await mount({ kind: 'number', value: 4, wired: true })
  assert.equal(t.field().disabled, true)
  await t.type('12')
  await t.press('Enter')
  await t.blur()

  assert.deepEqual(t.commits, [])
})

test('text typed before an edge arrives is not committed when the field is left', async () => {
  const t = await mount({ kind: 'number', value: 4 })
  await t.type('12')
  await t.wire()
  // A browser that blurs a field as it is disabled sends this; jsdom moves
  // focus away without an event, so it is sent here.
  await t.focusOut()

  assert.deepEqual(t.commits, [])
})

test('a wired toggle commits nothing', async () => {
  const t = await mount({ kind: 'boolean', value: false, wired: true })
  const toggle = t.container.querySelector('[role="switch"]')
  assert.ok(toggle, 'the toggle is there')
  await t.click(toggle)

  assert.deepEqual(t.commits, [])
})
