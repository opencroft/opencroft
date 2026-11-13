// The frame each look is drawn in before the editor has loaded. The field's
// selection bar is exercised through the editor in
// `./markdown-editor-field.test.tsx`.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditorPlaceholder: typeof import('./markdown-editor-frame').MarkdownEditorPlaceholder

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownEditorPlaceholder } = await import('./markdown-editor-frame'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

test('the placeholder is drawn in the frame of the look it stands in for', async () => {
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<MarkdownEditorPlaceholder className='flex-1' />))
  const box = container.querySelector('[data-slot="markdown-editor"]')
  assert.ok(box?.classList.contains('border') && box.classList.contains('flex-1'), 'the toolbar look is a bordered box')
  assert.equal(container.querySelector('[data-slot="markdown-editor-field"]'), null)
  await act(async () => next.render(<MarkdownEditorPlaceholder variant='field' className='flex-1' />))
  const field = container.querySelector('[data-slot="markdown-editor-field"]')
  assert.ok(field?.classList.contains('flex-1'), 'the field look is the field')
  assert.equal(container.querySelector('[data-slot="markdown-editor"]'), null)
})
