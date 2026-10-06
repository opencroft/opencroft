// Which presses are the canvas's undo and redo: Ctrl/Cmd+Z, Ctrl+Y and
// Ctrl/Cmd+Shift+Z on the canvas itself, never inside something that edits
// text, which keeps its own undo.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
const { undoKeyAction } = await import('./canvas-undo-keys')

after(() => dom.cleanup())

function build() {
  dom.container.innerHTML = `
    <div data-testid="canvas" tabindex="-1">
      <div data-testid="node"></div>
      <textarea data-testid="node-field"></textarea>
      <div class="nokey" data-testid="code-editor"><div data-testid="code-line"></div></div>
    </div>
    <input data-testid="inspector-input" />
  `
  const el = (testId: string) => {
    const found = dom.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    assert.ok(found, `expected ${testId} in the fixture`)
    return found
  }
  return el
}

function keyOn(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { bubbles: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  return event
}

test('Ctrl+Z and Cmd+Z on the canvas undo', () => {
  const el = build()
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyZ', ctrlKey: true }), el('canvas')), 'undo')
  assert.equal(undoKeyAction(keyOn(el('canvas'), { code: 'KeyZ', metaKey: true }), el('canvas')), 'undo')
})

test('Ctrl+Y, Ctrl+Shift+Z and Cmd+Shift+Z on the canvas redo', () => {
  const el = build()
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyY', ctrlKey: true }), el('canvas')), 'redo')
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyZ', ctrlKey: true, shiftKey: true }), el('canvas')), 'redo')
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyZ', metaKey: true, shiftKey: true }), el('canvas')), 'redo')
})

test('the keys are matched on the physical key, whatever character the layout gives it', () => {
  const el = build()
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyZ', key: 'я', ctrlKey: true }), el('canvas')), 'undo')
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyY', key: 'z', ctrlKey: true }), el('canvas')), 'redo')
})

test('a text field, a code editor and anything outside the canvas keep their own undo', () => {
  const el = build()
  for (const target of ['node-field', 'code-line', 'inspector-input']) {
    assert.equal(undoKeyAction(keyOn(el(target), { code: 'KeyZ', ctrlKey: true }), el('canvas')), null, target)
  }
})

test('Z without a modifier, with Alt, and Shift+Ctrl+Y are not undo or redo', () => {
  const el = build()
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyZ' }), el('canvas')), null)
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyZ', ctrlKey: true, altKey: true }), el('canvas')), null)
  assert.equal(undoKeyAction(keyOn(el('node'), { code: 'KeyY', ctrlKey: true, shiftKey: true }), el('canvas')), null)
})
