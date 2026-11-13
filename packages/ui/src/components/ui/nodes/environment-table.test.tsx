// A row's fields commit when they lose focus, and the press that takes focus
// away is usually on another control in the same row: its X or its key button.
// The commit lands between that press and its release, so the row has to keep
// the very same elements through it, or the release reaches nothing and the
// click is lost. Mounted in a DOM rather than rendered to markup, because what
// is checked is element identity across a commit.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

import type { EnvironmentTableProps, EnvironmentVariable } from './environment-table'

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
    'Element',
    'Node',
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

// Compared by identity with a message of its own: a failed assertion that
// prints a jsdom element never finishes printing it.
function assertSameButtons(
  now: { remove: HTMLButtonElement; secret: HTMLButtonElement },
  then: { remove: HTMLButtonElement; secret: HTMLButtonElement },
) {
  assert.ok(now.remove === then.remove, 'the X is the element that was there before the commit')
  assert.ok(now.secret === then.secret, 'the key button is the element that was there before the commit')
  assert.ok(then.remove.isConnected && then.secret.isConnected, 'both are still in the document')
}

let unmount: (() => Promise<void>) | null = null

afterEach(async () => {
  await unmount?.()
  unmount = null
})

const STARTING: EnvironmentVariable[] = [
  { name: 'GREETING', value: 'hello' },
  { name: 'PORT', value: '8080' },
]

// Imported after the DOM exists: react-dom binds to the globals it finds when
// first loaded. The host holds the list in state, as a node's data would.
async function mount(props: Pick<EnvironmentTableProps, 'valueWarning' | 'secrets'> = { secrets: ['ALPHA_TOKEN'] }) {
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { EnvironmentTable } = await import('./environment-table')

  const changes: EnvironmentVariable[][] = []
  let setFromOutside: (variables: EnvironmentVariable[]) => void = () => {}
  let current = STARTING

  function Host() {
    const [variables, setVariables] = useState(STARTING)
    current = variables
    setFromOutside = setVariables
    return createElement(EnvironmentTable, {
      ...props,
      variables,
      onChange: (next: EnvironmentVariable[]) => {
        changes.push(next)
        setVariables(next)
      },
    })
  }

  const container = dom.window.document.getElementById('root')
  assert.ok(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(Host)))
  unmount = async () => act(async () => root.unmount())

  const rows = () => [...container.querySelectorAll('tbody tr')]
  const field = (row: number, label: 'Variable' | 'Value') => {
    const input = rows()[row]?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
    assert.ok(input, `row ${row} has a ${label} field`)
    return input
  }
  const buttons = (row: number) => {
    const remove = rows()[row]?.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')
    const secret = rows()[row]?.querySelector<HTMLButtonElement>('button[aria-label="Use a secret"]')
    assert.ok(remove && secret, `row ${row} has its buttons`)
    return { remove, secret }
  }

  return {
    act,
    changes,
    field,
    buttons,
    rows,
    variables: () => current,
    fromOutside: (variables: EnvironmentVariable[]) => act(async () => setFromOutside(variables)),
    // What a person's typing does: the element's own value setter, then the
    // input event React listens for.
    type: (input: HTMLInputElement, text: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, text)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      }),
    focus: (element: HTMLElement) => act(async () => element.focus()),
    blur: (input: HTMLInputElement) => act(async () => input.blur()),
    click: (button: HTMLButtonElement) => act(async () => button.click()),
    add: () => {
      const button = container.querySelector<HTMLButtonElement>('button[aria-label="Add variable"]')
      assert.ok(button, 'the table has its plus')
      return button
    },
    handle: (row: number) => {
      const handle = rows()[row]?.querySelector<HTMLElement>('[aria-label^="Move"]')
      assert.ok(handle, `row ${row} has its handle`)
      return handle
    },
    key: (element: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
      act(async () => {
        element.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
        )
      }),
    text: () => container.textContent ?? '',
    // A native drag from `source` dropped on `target`, as a mouse makes it.
    // Each event in a render of its own: the drop reads what the drag start set.
    drag: async (source: HTMLElement, target: HTMLElement) => {
      const fire = (element: HTMLElement, type: string) =>
        act(async () => {
          const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
          Object.defineProperty(event, 'dataTransfer', {
            value: { setData: () => {}, effectAllowed: 'all', dropEffect: 'none' },
          })
          element.dispatchEvent(event)
        })
      await fire(source, 'dragstart')
      await fire(target, 'dragover')
      await fire(target, 'drop')
      await fire(source, 'dragend')
    },
  }
}

test('a value committed on blur leaves the row its own buttons, and its X still removes it', async () => {
  const t = await mount()
  const before = t.buttons(1)
  const value = t.field(1, 'Value')
  await t.focus(value)
  await t.type(value, '9090')
  await t.blur(value)

  assert.deepEqual(t.changes.at(-1), [
    { name: 'GREETING', value: 'hello' },
    { name: 'PORT', value: '9090' },
  ])
  assertSameButtons(t.buttons(1), before)

  await t.click(before.remove)
  assert.deepEqual(t.variables(), [{ name: 'GREETING', value: 'hello' }])
})

test('a value whose commit brings a warning leaves the row its own field and buttons', async () => {
  const t = await mount({
    secrets: ['ALPHA_TOKEN'],
    valueWarning: ({ value }) => (value.startsWith('Bearer ') ? 'Typed credential.' : undefined),
  })
  const before = t.buttons(1)
  const value = t.field(1, 'Value')
  await t.focus(value)
  await t.type(value, 'Bearer placeholder')
  await t.blur(value)

  assert.ok(t.rows()[1]?.querySelector('[role="img"][aria-label="Typed credential."]'), 'the row is marked')
  assert.ok(t.field(1, 'Value') === value, 'the value field is the element that was there before the commit')
  assertSameButtons(t.buttons(1), before)

  await t.click(before.remove)
  assert.deepEqual(t.variables(), [{ name: 'GREETING', value: 'hello' }])
})

test('a rename committed on blur leaves the row its own buttons, and its X still removes it', async () => {
  const t = await mount()
  const before = t.buttons(1)
  const name = t.field(1, 'Variable')
  await t.focus(name)
  await t.type(name, 'HTTP_PORT')
  await t.blur(name)

  assert.deepEqual(t.changes.at(-1), [
    { name: 'GREETING', value: 'hello' },
    { name: 'HTTP_PORT', value: '8080' },
  ])
  assertSameButtons(t.buttons(1), before)

  await t.click(before.remove)
  assert.deepEqual(t.variables(), [{ name: 'GREETING', value: 'hello' }])
})

test('leaving a field without typing writes nothing back over a change made elsewhere', async () => {
  const t = await mount()
  const value = t.field(1, 'Value')
  await t.focus(value)
  await t.fromOutside([
    { name: 'GREETING', value: 'hello' },
    { name: 'PORT', value: '7070' },
  ])
  await t.blur(value)

  assert.deepEqual(t.changes, [], 'leaving the field sent no change')
  assert.deepEqual(t.variables(), [
    { name: 'GREETING', value: 'hello' },
    { name: 'PORT', value: '7070' },
  ])
  assert.equal(t.field(1, 'Value').value, '7070')
})

test('without secrets the rows have no key button, and a row named with an empty value keeps it', async () => {
  const t = await mount({ secrets: undefined })
  assert.ok(t.rows()[0]?.querySelector('button[aria-label="Use a secret"]') === null, 'a row has no key button')
  assert.ok(t.rows()[0]?.querySelector('button[aria-label^="Remove"]'), 'the row still has its X')

  await t.click(t.add())
  assert.ok(t.rows()[2]?.querySelector('button[aria-label="Use a secret"]') === null, 'the new row has no key button')
  const name = t.field(2, 'Variable')
  await t.type(name, 'EMPTY')
  await t.blur(name)

  assert.deepEqual(t.variables(), [...STARTING, { name: 'EMPTY', value: '' }])
})

test('the plus is in the header, and no row has one', async () => {
  const t = await mount()
  assert.ok(t.add().closest('thead'), 'the plus is in the header row')
  assert.equal(t.rows().filter((row) => row.querySelector('button[aria-label^="Add"]')).length, 0)
})

test('the plus appends an empty row with the focus in its name, and stores nothing yet', async () => {
  const t = await mount()
  await t.click(t.add())

  assert.equal(t.rows().length, 3)
  const name = t.field(2, 'Variable')
  assert.equal(name.value, '')
  assert.ok(dom.window.document.activeElement === name, 'the new row has the focus in its name')
  assert.deepEqual(t.changes, [], 'a row with no name is not stored')
})

test('a new row named and given a value, each left without Enter, is stored with both', async () => {
  const t = await mount()
  await t.click(t.add())
  const name = t.field(2, 'Variable')
  await t.type(name, 'DATA_DIR')
  const value = t.field(2, 'Value')
  // The press on the value field takes the focus from the name.
  await t.focus(value)
  assert.deepEqual(t.variables(), [...STARTING, { name: 'DATA_DIR', value: '' }])
  assert.ok(t.field(2, 'Value') === value, 'naming the row keeps its value field the same element')

  await t.type(value, '/srv/data')
  await t.blur(value)
  assert.deepEqual(t.variables(), [...STARTING, { name: 'DATA_DIR', value: '/srv/data' }])
})

test('a value typed into a row with no name stays on screen, says it is not saved, and joins once named', async () => {
  const t = await mount()
  await t.click(t.add())
  const value = t.field(2, 'Value')
  await t.focus(value)
  await t.type(value, 'kept')
  await t.blur(value)

  assert.deepEqual(t.changes, [], 'nothing is stored without a name')
  assert.equal(t.field(2, 'Value').value, 'kept', 'the value stays in its row')
  assert.match(t.text(), /A variable without a name is not saved\./)

  const name = t.field(2, 'Variable')
  await t.focus(name)
  await t.type(name, 'KEPT')
  await t.blur(name)
  assert.deepEqual(t.variables(), [...STARTING, { name: 'KEPT', value: 'kept' }])
  assert.doesNotMatch(t.text(), /not saved/)
})

test('a new row given a name another row holds is refused and stays, without a name', async () => {
  const t = await mount()
  await t.click(t.add())
  const name = t.field(2, 'Variable')
  await t.type(name, 'PORT')
  await t.blur(name)

  assert.deepEqual(t.changes, [])
  assert.equal(t.rows().length, 3)
  assert.equal(t.field(2, 'Variable').value, '')
  assert.match(t.text(), /There is already a variable named PORT\./)
})

test('the X removes a row with no name without storing anything', async () => {
  const t = await mount()
  await t.click(t.add())
  await t.click(t.buttons(2).remove)

  assert.equal(t.rows().length, 2)
  assert.deepEqual(t.changes, [])
})

test('the arrow keys on a handle move its row a place, and the handle keeps the focus', async () => {
  const t = await mount()
  const handle = t.handle(1)
  await t.focus(handle)
  await t.key(handle, 'ArrowUp')
  assert.deepEqual(t.variables(), [STARTING[1], STARTING[0]])
  assert.ok(dom.window.document.activeElement === handle, 'the moved row keeps the focus on its handle')

  await t.key(handle, 'ArrowDown', { altKey: true })
  assert.deepEqual(t.variables(), STARTING)

  await t.key(t.handle(1), 'ArrowDown')
  assert.equal(t.changes.length, 2, 'the last row goes no further down')
})

test('a row with no name moves among the others, and the named ones keep their order around it', async () => {
  const t = await mount()
  await t.click(t.add())
  await t.key(t.handle(2), 'ArrowUp')
  assert.deepEqual(t.changes, [], 'the stored order did not change')
  assert.equal(t.field(1, 'Variable').value, '', 'the row with no name is second now')

  const name = t.field(1, 'Variable')
  await t.focus(name)
  await t.type(name, 'MIDDLE')
  await t.blur(name)
  assert.deepEqual(t.variables(), [STARTING[0], { name: 'MIDDLE', value: '' }, STARTING[1]])
})

test('a row dragged by its handle and dropped on another lands after it', async () => {
  const t = await mount({ secrets: ['ALPHA_TOKEN'] })
  await t.fromOutside([...STARTING, { name: 'THIRD', value: '3' }])
  // jsdom lays nothing out, so every row's box is empty and a drop on a row
  // lands after it.
  await t.drag(t.handle(2), t.field(0, 'Variable'))
  assert.deepEqual(t.variables(), [STARTING[0], { name: 'THIRD', value: '3' }, STARTING[1]])
})

test('a focused field shows a change made elsewhere until something is typed', async () => {
  const t = await mount()
  const value = t.field(1, 'Value')
  await t.focus(value)
  await t.fromOutside([
    { name: 'GREETING', value: 'hello' },
    { name: 'PORT', value: '7070' },
  ])
  assert.equal(value.value, '7070')
})
