// The keyboard path through a node's row list: each row a focus stop, its
// menu opened from the keyboard, rows moved with Alt and an arrow, and the
// focus kept on a row the host draws anew. Mounted in a DOM, with the rows
// held by a host as a node's data holds them, because what is checked is
// keys, focus and the order they leave.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

import type { NodeRow } from './node-row-list'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  // The menu primitive also reaches for a rect to position against and an
  // abort signal jsdom's own listeners accept (Node's is a different class).
  const names = [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'MouseEvent',
    'KeyboardEvent',
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

const START: NodeRow[] = [
  { id: 'red', label: 'red' },
  { id: 'green', label: 'green' },
  { id: 'blue', label: 'blue' },
]

// Imported after the DOM exists: react-dom binds to the globals it finds when
// first loaded. A renamed row comes back under its new name as its id, as a
// text port's choices do, so it is a new row to React. The host draws `rows`
// anew on every render from what it holds, as a node's card does. With
// `later`, it holds a change until the test lets it answer (`settle`), not in
// the press's own batch.
async function mount({ later = false }: { later?: boolean } = {}) {
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { NodeRowList } = await import('./node-row-list')

  const reorders: string[][] = []
  const held: (() => void)[] = []
  let redraw = () => {}
  function Host() {
    const [rows, setRows] = useState(START)
    const [, setDraws] = useState(0)
    redraw = () => setDraws((n) => n + 1)
    const answer = (next: (now: NodeRow[]) => NodeRow[]) => {
      if (later) {
        held.push(() => setRows(next))
      } else {
        setRows(next)
      }
    }
    return createElement(NodeRowList, {
      label: 'Colours',
      rows: rows.map((r) => ({ ...r })),
      onReorder: (ids: string[]) => {
        reorders.push(ids)
        answer((now) => ids.map((id) => now.find((r) => r.id === id) as NodeRow))
      },
      onRename: (id: string, label: string) =>
        answer((now) => now.map((r) => (r.id === id ? { id: label, label } : r))),
      onDelete: (id: string) => answer((now) => now.filter((r) => r.id !== id)),
    })
  }

  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  await act(async () => root.render(createElement(Host)))
  unmount = async () => {
    await act(async () => root.unmount())
  }

  const row = (label: string) =>
    [...container.querySelectorAll<HTMLElement>('[data-node-row-name]')].find((el) => el.textContent === label)
  const labels = () => [...container.querySelectorAll('[data-node-row-name]')].map((el) => el.textContent)
  // Compared as a boolean: a failing comparison of two jsdom elements prints
  // them, which walks the whole window and stalls the run.
  const focused = (label: string) => document.activeElement === row(label)
  const press = async (
    target: Element,
    key: string,
    mods: { altKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean } = {},
  ) => {
    let event: KeyboardEvent | undefined
    await act(async () => {
      event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
      target.dispatchEvent(event)
    })
    return event as KeyboardEvent
  }
  const focus = async (label: string) => {
    await act(async () => row(label)?.focus())
  }
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label)
  const frame = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  // The host drawn again with nothing changed: a fresh `rows` all the same.
  const drawAgain = () => act(async () => redraw())
  // Lets a `later` host answer. It draws once more with nothing changed
  // first, as a node's card on the canvas does after a Switch case or an
  // Inputs node's port is deleted (measured in Chromium).
  const settle = async () => {
    await drawAgain()
    await act(async () => {
      for (const answer of held.splice(0)) {
        answer()
      }
    })
  }
  // Opens a row's menu from the keyboard and waits the frame in which the
  // menu takes the focus, as a person can't choose an entry sooner.
  const openMenu = async (label: string) => {
    await press(row(label) as HTMLElement, 'F10', { shiftKey: true })
    await frame()
  }
  return { act, row, labels, focused, press, focus, item, frame, settle, drawAgain, openMenu, reorders }
}

test('every row is a focus stop of its own, offering a menu', async () => {
  const { row } = await mount()
  for (const label of ['red', 'green', 'blue']) {
    const el = row(label)
    assert.equal(el?.tabIndex, 0, `${label} is reachable with Tab`)
    assert.equal(el?.getAttribute('role'), 'button')
    assert.equal(el?.getAttribute('aria-haspopup'), 'menu')
    assert.equal(el?.getAttribute('aria-keyshortcuts'), 'Shift+F10 Alt+ArrowUp Alt+ArrowDown Delete Backspace')
  }
})

test('Alt+ArrowDown and Alt+ArrowUp move the row a place, and it keeps the focus', async () => {
  const { focus, press, row, labels, focused, reorders } = await mount()
  await focus('red')
  await press(row('red') as HTMLElement, 'ArrowDown', { altKey: true })
  assert.deepEqual(labels(), ['green', 'red', 'blue'])
  assert.equal(focused('red'), true, 'the moved row keeps the focus')
  await press(row('red') as HTMLElement, 'ArrowDown', { altKey: true })
  await press(row('red') as HTMLElement, 'ArrowUp', { altKey: true })
  assert.deepEqual(labels(), ['green', 'red', 'blue'])
  assert.equal(focused('red'), true)
  assert.deepEqual(reorders, [
    ['green', 'red', 'blue'],
    ['green', 'blue', 'red'],
    ['green', 'red', 'blue'],
  ])
})

test('a row at either end moves no further', async () => {
  const { focus, press, row, labels, reorders } = await mount()
  await focus('red')
  await press(row('red') as HTMLElement, 'ArrowUp', { altKey: true })
  await focus('blue')
  await press(row('blue') as HTMLElement, 'ArrowDown', { altKey: true })
  assert.deepEqual(reorders, [])
  assert.deepEqual(labels(), ['red', 'green', 'blue'])
})

test('the arrows go to the row above or below and move nothing', async () => {
  const { focus, press, row, focused, reorders } = await mount()
  await focus('green')
  await press(row('green') as HTMLElement, 'ArrowDown')
  assert.equal(focused('blue'), true)
  await press(row('blue') as HTMLElement, 'ArrowDown')
  assert.equal(focused('blue'), true, 'the last row keeps the focus')
  await press(row('blue') as HTMLElement, 'ArrowUp')
  await press(row('green') as HTMLElement, 'ArrowUp')
  assert.equal(focused('red'), true)
  assert.deepEqual(reorders, [])
})

test('a key a row handles stops at the row; any other reaches the page', async () => {
  const { focus, press, row } = await mount()
  const heard: string[] = []
  const listen = (e: KeyboardEvent) => heard.push(e.key)
  document.addEventListener('keydown', listen)
  try {
    await focus('green')
    const arrow = await press(row('green') as HTMLElement, 'ArrowUp')
    const other = await press(row('red') as HTMLElement, 'x')
    const ctrlDelete = await press(row('red') as HTMLElement, 'Delete', { ctrlKey: true })
    assert.deepEqual(heard, ['x', 'Delete'])
    assert.equal(arrow.defaultPrevented, true, 'an arrow does not scroll the page')
    assert.equal(other.defaultPrevented, false)
    assert.equal(ctrlDelete.defaultPrevented, false)
  } finally {
    document.removeEventListener('keydown', listen)
  }
})

for (const [name, key, mods] of [
  ['Shift+F10', 'F10', { shiftKey: true }],
  ['the menu key', 'ContextMenu', {}],
  ['Enter', 'Enter', {}],
  ['Space', ' ', {}],
] as const) {
  test(`${name} opens the row's menu with Rename and Delete`, async () => {
    const { focus, press, row, item } = await mount()
    await focus('green')
    const event = await press(row('green') as HTMLElement, key, mods)
    assert.ok(item('Rename'), 'Rename is offered')
    assert.ok(item('Delete'), 'Delete is offered')
    assert.equal(event.defaultPrevented, true, 'the browser opens no menu of its own')
  })
}

test('F10 without Shift opens no menu', async () => {
  const { focus, press, row, item } = await mount()
  await focus('green')
  await press(row('green') as HTMLElement, 'F10')
  assert.equal(item('Delete') === undefined, true)
})

test('Delete from a menu the keyboard opened gives the focus to the row now in its place', async () => {
  const { act, focus, openMenu, item, labels, focused } = await mount()
  await focus('green')
  await openMenu('green')
  await act(async () => item('Delete')?.click())
  assert.deepEqual(labels(), ['red', 'blue'])
  assert.equal(focused('blue'), true)
})

test('Delete of the last row gives the focus to the row above it', async () => {
  const { act, focus, openMenu, item, labels, focused } = await mount()
  await focus('blue')
  await openMenu('blue')
  await act(async () => item('Delete')?.click())
  assert.deepEqual(labels(), ['red', 'green'])
  assert.equal(focused('green'), true)
})

for (const [ending, expected] of [
  ['Enter', 'teal'],
  ['Escape', 'green'],
] as const) {
  test(`a rename ended with ${ending} gives the focus back to the row`, async () => {
    const { act, focus, press, openMenu, item, labels, focused, frame } = await mount()
    await focus('green')
    await openMenu('green')
    await act(async () => item('Rename')?.click())
    await frame()
    const input = document.activeElement as HTMLInputElement
    assert.equal(input.tagName, 'INPUT', 'the name is a focused field')
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, 'teal')
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    await press(input, ending)
    assert.deepEqual(labels(), ['red', expected, 'blue'])
    assert.equal(focused(expected), true, 'the row under its name has the focus')
  })
}

for (const [key, gone, next, left] of [
  ['Delete', 'green', 'blue', ['red', 'blue']],
  ['Backspace', 'blue', 'green', ['red', 'green']],
] as const) {
  test(`${key} on a row deletes that row, hands its focus on, and reaches nothing else`, async () => {
    const { focus, press, row, labels, focused } = await mount()
    const heard: string[] = []
    const listen = (e: KeyboardEvent) => heard.push(e.key)
    document.addEventListener('keydown', listen)
    try {
      await focus(gone)
      const event = await press(row(gone) as HTMLElement, key)
      assert.deepEqual(labels(), left)
      assert.equal(focused(next), true, `${next} takes the focus`)
      assert.deepEqual(heard, [], 'the page hears no Delete to delete a node with')
      assert.equal(event.defaultPrevented, true)
    } finally {
      document.removeEventListener('keydown', listen)
    }
  })
}

// A node's card answers through the graph, so the answer can come a task
// later, and the card draws a fresh `rows` every time it renders.

test('Delete on a row the host deletes later gives the focus to the row in its place', async () => {
  const { focus, press, row, labels, focused, settle } = await mount({ later: true })
  await focus('green')
  await press(row('green') as HTMLElement, 'Delete')
  assert.deepEqual(labels(), ['red', 'green', 'blue'], 'not deleted yet')
  await settle()
  assert.deepEqual(labels(), ['red', 'blue'])
  assert.equal(focused('blue'), true)
})

test('Delete from a keyboard-opened menu, answered later, gives the focus to the row in its place', async () => {
  const { act, focus, openMenu, item, labels, focused, settle } = await mount({ later: true })
  await focus('green')
  await openMenu('green')
  await act(async () => item('Delete')?.click())
  await settle()
  assert.deepEqual(labels(), ['red', 'blue'])
  assert.equal(focused('blue'), true)
})

test('a rename to a new row, answered after the field has closed, gives the focus to the new row', async () => {
  const { act, focus, press, openMenu, item, labels, focused, frame, settle } = await mount({ later: true })
  await focus('green')
  await openMenu('green')
  await act(async () => item('Rename')?.click())
  await frame()
  const input = document.activeElement as HTMLInputElement
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, 'teal')
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await press(input, 'Enter')
  assert.deepEqual(labels(), ['red', 'green', 'blue'], 'the field has closed; the host has not answered')
  await settle()
  assert.deepEqual(labels(), ['red', 'teal', 'blue'])
  assert.equal(focused('teal'), true)
})

test('focus the user moves elsewhere before the host answers stays there', async () => {
  const { focus, press, row, labels, focused, settle } = await mount({ later: true })
  await focus('green')
  await press(row('green') as HTMLElement, 'Delete')
  await focus('red')
  await settle()
  assert.deepEqual(labels(), ['red', 'blue'])
  assert.equal(focused('red'), true)
})

test('focus the user drops to the page before the host answers stays there', async () => {
  const { act, focus, press, row, labels, settle } = await mount({ later: true })
  await focus('green')
  await press(row('green') as HTMLElement, 'Delete')
  await act(async () => row('green')?.blur())
  await settle()
  assert.deepEqual(labels(), ['red', 'blue'])
  assert.equal(document.activeElement === document.body, true, 'no row takes the focus')
})

test('once the host has answered, the list takes no focus back from the page', async () => {
  const { act, focus, press, row, focused, settle, drawAgain } = await mount({ later: true })
  await focus('green')
  await press(row('green') as HTMLElement, 'Delete')
  await settle()
  assert.equal(focused('blue'), true)
  await act(async () => row('blue')?.blur())
  await drawAgain()
  assert.equal(document.activeElement === document.body, true, 'the focus stays on the page')
})

test('the row that took the focus from a deleted one keeps it through a move', async () => {
  const { focus, press, row, labels, focused, settle } = await mount({ later: true })
  await focus('green')
  await press(row('green') as HTMLElement, 'Delete')
  await settle()
  assert.equal(focused('blue'), true)
  await press(row('blue') as HTMLElement, 'ArrowUp', { altKey: true })
  await settle()
  assert.deepEqual(labels(), ['blue', 'red'])
  assert.equal(focused('blue'), true, 'no row takes the focus from it')
})
