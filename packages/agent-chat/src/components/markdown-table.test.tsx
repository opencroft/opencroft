// The editable table's controls through their real gestures: a press on a
// `+`, a grip's menu, a right-click on a cell, a mouse drag of a grip. Each is
// checked by the command it reports, which is the component's whole output.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'
import type { MarkdownTableCommand, MarkdownTableSelection } from './markdown-table'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownTable: typeof import('./markdown-table').MarkdownTable

before(async () => {
  container = installTestDom()
  const globals = globalThis as unknown as Record<string, unknown>
  // What the menu primitives and the table reach for beyond the shared test DOM.
  for (const name of [
    'DOMRect',
    'AbortController',
    'AbortSignal',
    'PointerEvent',
    'HTMLTableCellElement',
    'HTMLTableRowElement',
  ]) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  // jsdom lays nothing out, so each element reports the box its `data-box`
  // gives it ("x y width height"), and nothing resizes.
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const [x, y, width, height] = (this.dataset.box ?? '0 0 0 0').split(' ').map(Number)
    return new window.DOMRect(x, y, width, height)
  }
  window.HTMLElement.prototype.setPointerCapture = () => {}
  globals.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownTable } = await import('./markdown-table'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

afterEach(unmount)

/** A two-by-three table, 100 wide per column and 20 high per row, in editable form. */
async function mount(selection: MarkdownTableSelection | null): Promise<MarkdownTableCommand[]> {
  await unmount()
  const commands: MarkdownTableCommand[] = []
  const next = createRoot(container)
  root = next
  await act(async () =>
    next.render(
      <MarkdownTable
        editing={{ selection, onCommand: (command) => commands.push(command) }}
        table={
          <table data-box='0 0 300 40'>
            <tbody>
              <tr data-box='0 0 300 20'>
                <th data-box='0 0 100 20'>a</th>
                <th data-box='100 0 100 20'>b</th>
                <th data-box='200 0 100 20'>c</th>
              </tr>
              <tr data-box='0 20 300 20'>
                <td data-box='0 20 100 20'>1</td>
                <td data-box='100 20 100 20' id='cell-1-1'>
                  2
                </td>
                <td data-box='200 20 100 20'>3</td>
              </tr>
            </tbody>
          </table>
        }
      />,
    ),
  )
  return commands
}

function labelled(label: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[aria-label="${label}"]`)]
}

function control(label: string): HTMLElement {
  const [found] = labelled(label)
  assert.ok(found, `no control labelled "${label}"`)
  return found
}

function item(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label,
  )
  assert.ok(found, `no "${label}" item in the open menu`)
  return found
}

async function press(element: HTMLElement) {
  await act(async () => element.click())
}

const GRIPS = ['Column 1', 'Column 2', 'Column 3', 'Row 1', 'Row 2']

/** Which grips show, in `GRIPS` order. */
function gripsShown(): boolean[] {
  return GRIPS.map((label) => labelled(label).length === 1)
}

/** Where the `+` controls sit along each strip, in pixels from the table's top-left corner. */
function insertsShown(): { columns: number[]; rows: number[] } {
  return {
    columns: labelled('Insert column here').map((button) => Number.parseFloat(button.style.left)),
    rows: labelled('Insert row here').map((button) => Number.parseFloat(button.style.top)),
  }
}

/** A cell, or a block of cells, by inclusive row and column ranges. */
function cells(top: number, left: number, bottom = top, right = left): MarkdownTableSelection {
  return { top, left, bottom, right }
}

test('with no caret in the table, no row or column control shows', async () => {
  await mount(null)
  assert.deepEqual(gripsShown(), [false, false, false, false, false])
  assert.equal(labelled('Insert column here').length + labelled('Insert row here').length, 0)
})

test('the caret cell row and column get a grip each and a + on either side, and no other does', async () => {
  await mount(cells(1, 1))
  assert.deepEqual(gripsShown(), [false, true, false, false, true])
  // Columns are 100 wide and rows 20 high: the second column's edges, the second row's.
  assert.deepEqual(insertsShown(), { columns: [100, 200], rows: [20, 40] })
})

test('a block of cells shows the controls of all its rows and columns', async () => {
  await mount(cells(0, 1, 1, 2))
  assert.deepEqual(gripsShown(), [false, true, true, true, true])
  assert.deepEqual(insertsShown(), { columns: [100, 200, 300], rows: [0, 20, 40] })
})

test('a + inserts at its own boundary', async () => {
  const commands = await mount(cells(1, 1))
  await press(labelled('Insert column here')[1])
  await press(labelled('Insert row here')[0])
  assert.deepEqual(commands, [
    { type: 'insertColumn', index: 2 },
    { type: 'insertRow', index: 1 },
  ])
})

test('a grip press selects its column and opens its menu, where impossible moves are disabled', async () => {
  const commands = await mount(cells(0, 0))
  await press(control('Column 1'))
  assert.deepEqual(commands, [{ type: 'selectColumn', index: 0 }])
  assert.equal(item('Move column left').hasAttribute('data-disabled'), true)
  await press(item('Move column right'))
  assert.deepEqual(commands.at(-1), { type: 'moveColumn', from: 0, to: 1 })
})

test('the column menu sets alignment, and left clears it', async () => {
  const commands = await mount(cells(0, 1))
  await press(control('Column 2'))
  await press(item('Align center'))
  await press(control('Column 2'))
  await press(item('Align left'))
  assert.deepEqual(
    commands.filter((command) => command.type === 'alignColumn'),
    [
      { type: 'alignColumn', index: 1, align: 'center' },
      { type: 'alignColumn', index: 1, align: null },
    ],
  )
})

test('a right-click on a cell offers that cell row and column, and the table', async () => {
  const commands = await mount(cells(0, 0))
  const cell = document.getElementById('cell-1-1') as HTMLElement
  await act(async () => {
    cell.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 2, pointerType: 'mouse' }))
    cell.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  assert.ok(item('Delete table'))
  // Two rows: the last one cannot move down.
  assert.equal(item('Move row down').hasAttribute('data-disabled'), true)
  await press(item('Insert column left'))
  assert.deepEqual(commands, [{ type: 'insertColumn', index: 1 }])
})

test('dragging a grip with a mouse moves its column to where it is dropped, without opening the menu', async () => {
  const commands = await mount(cells(0, 0))
  const grip = control('Column 1')
  const pointer = (type: string, clientX: number) =>
    grip.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0, pointerType: 'mouse', clientX }))
  await act(async () => {
    pointer('pointerdown', 50)
    pointer('pointermove', 290)
  })
  await act(async () => {
    pointer('pointerup', 290)
    grip.click()
  })
  // Dropped on the last boundary: the first column becomes the last.
  assert.deepEqual(commands, [{ type: 'moveColumn', from: 0, to: 2 }])
  assert.equal(document.querySelectorAll('[role="menuitem"]').length, 0)
})

test('a drag draws its drop line only where a drop would move something', async () => {
  const commands = await mount(cells(0, 0))
  const grip = control('Column 1')
  const pointer = (type: string, clientX: number) =>
    grip.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0, pointerType: 'mouse', clientX }))
  const dropLines = () => document.querySelectorAll('[aria-hidden] > .bg-primary').length
  await act(async () => {
    pointer('pointerdown', 50)
    // The first column's own right edge.
    pointer('pointermove', 105)
  })
  assert.equal(dropLines(), 0)
  await act(async () => pointer('pointermove', 195))
  assert.equal(dropLines(), 1)
  await act(async () => pointer('pointermove', 95))
  assert.equal(dropLines(), 0)
  await act(async () => pointer('pointerup', 95))
  assert.deepEqual(commands, [])
})
