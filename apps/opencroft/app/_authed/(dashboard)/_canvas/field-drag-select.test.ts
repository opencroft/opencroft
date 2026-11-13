// Which presses on the canvas give a field the pointer: a primary mouse press
// in a text field on a node, so a drag selecting its text keeps selecting
// after it leaves the node. The selection itself is the browser's, which this
// DOM does not run; what is checked is which element captures the pointer.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { PointerEvent as ReactPointerEvent } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
const { captureFieldDragSelect } = await import('./field-drag-select')

after(() => dom.cleanup())

function build() {
  dom.container.innerHTML = `
    <div data-testid="canvas">
      <div class="react-flow__node" data-testid="node">
        <div data-testid="title">Format</div>
        <div class="nodrag nopan"><input data-testid="input" value="a template" /></div>
        <textarea data-testid="textarea">a prompt</textarea>
        <div contenteditable="true" data-testid="editable">
          <span data-testid="editable-text">notes</span>
          <div contenteditable="false"><button data-testid="editable-control">Copy</button></div>
        </div>
        <input type="checkbox" data-testid="checkbox" />
      </div>
      <input data-testid="canvas-input" />
    </div>
    <div class="react-flow__node"><input data-testid="portalled-input" /></div>
  `
  const captured: string[] = []
  for (const element of dom.container.querySelectorAll<HTMLElement>('[data-testid]')) {
    element.setPointerCapture = () => {
      captured.push(element.dataset.testid ?? '')
    }
  }
  const el = (testId: string) => {
    const found = dom.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    assert.ok(found, `expected ${testId} in the fixture`)
    return found
  }
  return { el, captured }
}

interface Press {
  pointerType?: string
  button?: number
  isPrimary?: boolean
}

// Calls the handler the way React would for a press on `target`, seen by the canvas in the capture phase.
function press(
  canvas: HTMLElement,
  target: HTMLElement,
  { pointerType = 'mouse', button = 0, isPrimary = true }: Press = {},
) {
  captureFieldDragSelect({
    currentTarget: canvas,
    target,
    pointerType,
    button,
    isPrimary,
    pointerId: 1,
  } as unknown as ReactPointerEvent<HTMLElement>)
}

test('a mouse press in a text input on a node gives the input the pointer', () => {
  const { el, captured } = build()
  press(el('canvas'), el('input'))
  assert.deepEqual(captured, ['input'])
})

test('a mouse press in a text area on a node gives the text area the pointer', () => {
  const { el, captured } = build()
  press(el('canvas'), el('textarea'))
  assert.deepEqual(captured, ['textarea'])
})

test('a press in editable content on a node, its text or a control inside it, captures nothing', () => {
  const { el, captured } = build()
  press(el('canvas'), el('editable-text'))
  press(el('canvas'), el('editable-control'))
  assert.deepEqual(captured, [])
})

test('a touch, a pen, a secondary button or a second pointer captures nothing', () => {
  const { el, captured } = build()
  press(el('canvas'), el('input'), { pointerType: 'touch' })
  press(el('canvas'), el('input'), { pointerType: 'pen' })
  press(el('canvas'), el('input'), { button: 2 })
  press(el('canvas'), el('input'), { isPrimary: false })
  assert.deepEqual(captured, [])
})

test('a press on a node outside its text fields captures nothing', () => {
  const { el, captured } = build()
  press(el('canvas'), el('title'))
  press(el('canvas'), el('checkbox'))
  assert.deepEqual(captured, [])
})

test('a field on the canvas outside any node, or drawn elsewhere through a portal, captures nothing', () => {
  const { el, captured } = build()
  press(el('canvas'), el('canvas-input'))
  press(el('canvas'), el('portalled-input'))
  assert.deepEqual(captured, [])
})
