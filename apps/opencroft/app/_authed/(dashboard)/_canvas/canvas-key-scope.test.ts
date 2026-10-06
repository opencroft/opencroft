// Pressing the canvas is what gives its shortcuts their scope: the press moves
// keyboard focus onto the canvas unless focus is already inside it.
import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'

import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
const { focusCanvasOnDrop, focusCanvasOnPress, keepFocusOnCanvas } = await import('./canvas-key-scope')
globalThis.MutationObserver ??= window.MutationObserver

after(() => dom.cleanup())

function build() {
  dom.container.innerHTML = `
    <div data-testid="canvas" tabindex="-1">
      <div data-testid="pane"></div>
      <input data-testid="node-input" />
    </div>
    <input data-testid="inspector-input" />
    <div data-testid="portalled"></div>
  `
  const el = (testId: string) => {
    const found = dom.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    assert.ok(found, `expected ${testId} in the fixture`)
    return found
  }
  return el
}

// Calls the handler the way React would for a press on `target`, bubbled to `canvas`.
function press(canvas: HTMLElement, target: HTMLElement) {
  focusCanvasOnPress({ currentTarget: canvas, target } as unknown as ReactPointerEvent<HTMLElement>)
}

beforeEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur()
})

test('a press on the pane moves focus from an editor elsewhere onto the canvas', () => {
  const el = build()
  el('inspector-input').focus()
  press(el('canvas'), el('pane'))
  assert.equal(document.activeElement, el('canvas'))
})

test('a press on the canvas leaves focus alone when it is already inside the canvas', () => {
  const el = build()
  el('node-input').focus()
  press(el('canvas'), el('pane'))
  assert.equal(document.activeElement, el('node-input'))
})

test('a press from portalled content that is not under the canvas on the page leaves focus alone', () => {
  const el = build()
  el('inspector-input').focus()
  press(el('canvas'), el('portalled'))
  assert.equal(document.activeElement, el('inspector-input'))
})

test('dropping a node from the palette moves focus from the palette onto the canvas', () => {
  const el = build()
  el('inspector-input').focus()
  focusCanvasOnDrop({ currentTarget: el('canvas') } as unknown as ReactDragEvent<HTMLElement>)
  assert.equal(document.activeElement, el('canvas'))
})

// Deleting what holds focus -- the selected node, or the inspector of a node
// someone else deleted -- must leave the canvas's shortcuts working.

function buildEditor() {
  dom.container.innerHTML = `
    <div data-testid="editor">
      <div data-testid="canvas" tabindex="-1">
        <div data-testid="node" tabindex="0"></div>
      </div>
      <div data-testid="inspector"><input data-testid="inspector-input" /></div>
    </div>
    <input data-testid="elsewhere" />
  `
  const el = (testId: string) => {
    const found = dom.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    assert.ok(found, `expected ${testId} in the fixture`)
    return found
  }
  const stop = keepFocusOnCanvas(el('editor'), el('canvas'))
  return { el, stop }
}

// Mutation observers report after the current task's microtasks.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('removing the focused node gives focus to the canvas', async () => {
  const { el, stop } = buildEditor()
  el('node').focus()
  el('node').remove()
  await settle()
  assert.equal(document.activeElement, el('canvas'))
  stop()
})

test('removing the inspector that has focus gives focus to the canvas', async () => {
  const { el, stop } = buildEditor()
  el('inspector-input').focus()
  el('inspector').remove()
  await settle()
  assert.equal(document.activeElement, el('canvas'))
  stop()
})

test('focus moved outside the editor stays there when the node it left is removed', async () => {
  const { el, stop } = buildEditor()
  el('node').focus()
  el('elsewhere').focus()
  el('node').remove()
  await settle()
  assert.equal(document.activeElement, el('elsewhere'))
  stop()
})

test('focus the user dropped to the page stays there when the node it left is removed', async () => {
  const { el, stop } = buildEditor()
  el('node').focus()
  el('node').blur()
  await settle()
  el('node').remove()
  await settle()
  assert.equal(document.activeElement, document.body)
  stop()
})

test('after cleanup, removing the focused node leaves focus to the browser', async () => {
  const { el, stop } = buildEditor()
  stop()
  el('node').focus()
  el('node').remove()
  await settle()
  assert.equal(document.activeElement, document.body)
})
