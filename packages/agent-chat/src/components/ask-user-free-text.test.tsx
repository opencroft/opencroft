// A free-text answer is a textarea with the chat composer's keys: Enter
// answers, Shift+Enter adds a line, and on a touch device Enter adds a line
// too. An Enter that belongs to an IME composition never answers. A secret
// stays a one-line password input.
//
// Mounted, because whether a key press answers is decided by its handler.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { questionsToElicitation } from 'agent-client/elicitation-form'
import type { ElicitationContentValue, ElicitationSchema } from 'agent-client/types'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let AskUser: typeof import('./ask-user').AskUser

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AskUser } = await import('./ask-user'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)
afterEach(async () => {
  await unmount()
  delete (window as { matchMedia?: unknown }).matchMedia
})

const FREE_TEXT: ElicitationSchema = {
  type: 'object',
  properties: { reason: { type: 'string', title: 'Reason' } },
  required: ['reason'],
} as ElicitationSchema

const SECRET: ElicitationSchema = {
  type: 'object',
  properties: { token: { type: 'string', title: 'Token', _meta: { codex: { isSecret: true } } } },
  required: ['token'],
} as ElicitationSchema

async function mount(schema: ElicitationSchema) {
  await unmount()
  const submitted: Record<string, ElicitationContentValue>[] = []
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<AskUser schema={schema} onSubmit={(content) => submitted.push(content)} />))
  return submitted
}

async function type(box: Element | null, text: string) {
  assert.ok(box instanceof window.HTMLTextAreaElement, 'the answer box is a textarea')
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(box, text)
    box.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

// Returns whether the press was claimed (default prevented): an unclaimed
// Enter in a textarea is the browser adding a line.
async function pressEnter(box: Element | null, init: KeyboardEventInit = {}): Promise<boolean> {
  assert.ok(box, 'the answer box is on the page')
  const event = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
  await act(async () => {
    box.dispatchEvent(event)
  })
  return event.defaultPrevented
}

const answerBox = () => container.querySelector('textarea')
const customBox = () => container.querySelector('textarea[placeholder="Custom answer (optional)"]')

test('a question without options answers in a one-line textarea', async () => {
  await mount(FREE_TEXT)
  const box = answerBox()
  assert.ok(box)
  assert.equal(box.getAttribute('rows'), '1')
  assert.equal(container.querySelector('input') === null, true, 'no one-line input beside it')
})

test('Shift+Enter adds a line, and the lines reach the answer', async () => {
  const submitted = await mount(FREE_TEXT)
  await type(answerBox(), 'First line')
  assert.equal(await pressEnter(answerBox(), { shiftKey: true }), false, 'Shift+Enter is left to the textarea')
  assert.deepEqual(submitted, [])
  await type(answerBox(), 'First line\nSecond line\nThird line')
  assert.equal(await pressEnter(answerBox()), true)
  assert.deepEqual(submitted, [{ reason: 'First line\nSecond line\nThird line' }])
})

test('the custom answer box keeps its line breaks and sends on Enter', async () => {
  const { schema } = questionsToElicitation([{ title: 'Ship', question: 'Ship it?', options: ['Yes', 'No'] }])
  const submitted = await mount(schema)
  await type(customBox(), 'After the freeze\nand the review')
  assert.equal(await pressEnter(customBox(), { shiftKey: true }), false)
  assert.deepEqual(submitted, [])
  assert.equal(await pressEnter(customBox()), true)
  assert.deepEqual(submitted, [{ question_0_custom: 'After the freeze\nand the review' }])
})

for (const [way, init] of [
  ['while composing', { isComposing: true }],
  ['reported after the composition ended (keyCode 229)', { keyCode: 229 }],
] as const) {
  test(`an IME Enter ${way} does not answer`, async () => {
    const submitted = await mount(FREE_TEXT)
    await type(answerBox(), 'にほんご')
    assert.equal(await pressEnter(answerBox(), init), false)
    assert.deepEqual(submitted, [])
  })
}

test('on a touch device Enter adds a line and the button answers', async () => {
  ;(window as { matchMedia?: unknown }).matchMedia = (query: string) => ({ matches: query === '(pointer: coarse)' })
  const submitted = await mount(FREE_TEXT)
  await type(answerBox(), 'From the phone')
  assert.equal(await pressEnter(answerBox()), false)
  assert.deepEqual(submitted, [])
})

test('a secret answer stays a one-line password input that sends on Enter', async () => {
  const submitted = await mount(SECRET)
  assert.equal(container.querySelector('textarea') === null, true, 'no textarea')
  const input = container.querySelector('input[type="password"]')
  assert.ok(input instanceof window.HTMLInputElement)
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(input, 'secret-value')
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.equal(await pressEnter(input, { shiftKey: true }), true, 'a one-line input answers on Shift+Enter too')
  assert.deepEqual(submitted, [{ token: 'secret-value' }])
})
