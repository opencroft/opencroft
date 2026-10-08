// A code block names its fence's language in a strip of its own over the code,
// names nothing when the fence names nothing, and copies only its code.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let CodeBlock: typeof import('./code-block').CodeBlock

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CodeBlock } = await import('./code-block'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

async function mount(element: import('react').ReactElement): Promise<HTMLElement> {
  const next = createRoot(container)
  root = next
  await act(async () => next.render(element))
  const frame = container.querySelector<HTMLElement>('[data-code-frame]')
  assert.ok(frame, 'the block is drawn in its frame')
  return frame
}

test('a block whose fence names a language shows it over the code, out of the selection', async () => {
  // `hcl` has no grammar, so the block stays the plain `pre` it first renders.
  const frame = await mount(<CodeBlock code={'bucket = "logs"'} language='hcl {1}' />)
  const label = frame.querySelector<HTMLElement>('[data-code-label]')
  assert.ok(label, 'the block has a label')
  assert.equal(label.textContent, 'hcl')
  assert.equal(label.getAttribute('contenteditable'), 'false')
  assert.ok(label.classList.contains('select-none'))
  // A strip of its own before the code, not a tag inside it.
  const pre = frame.querySelector('pre')
  assert.ok(pre && label.compareDocumentPosition(pre) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  assert.equal(pre.contains(label), false)
  assert.equal(pre.textContent, 'bucket = "logs"')
})

test('a block whose fence names no language has no label', async () => {
  const frame = await mount(<CodeBlock code='plain text' />)
  assert.equal(frame.querySelector('[data-code-label]'), null)
  assert.equal(frame.querySelector('pre')?.textContent, 'plain text')
})

test('copy puts the code on the clipboard, without its label', async () => {
  const copied: string[] = []
  const clipboard = Object.getOwnPropertyDescriptor(window.navigator, 'clipboard')
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  try {
    const frame = await mount(<CodeBlock code={'line one\nline two'} language='hcl' />)
    const copy = frame.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')
    assert.ok(copy, 'the block offers a copy control')
    await act(async () => copy.click())
    assert.deepEqual(copied, ['line one\nline two'])
  } finally {
    if (clipboard) {
      Object.defineProperty(window.navigator, 'clipboard', clipboard)
    } else {
      delete (window.navigator as { clipboard?: unknown }).clipboard
    }
  }
})
