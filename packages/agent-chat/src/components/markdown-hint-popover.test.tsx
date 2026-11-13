// The hint popover, mounted: its field starts from what the host passes,
// Apply is offered once there is a note and sends it trimmed, and Remove only
// for an existing hint.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownHintPopover: typeof import('./markdown-hint-popover').MarkdownHintPopover

before(async () => {
  container = installTestDom()
  // What the popup primitives reach for beyond the shared test DOM: a rect to
  // position against, and an abort signal jsdom's own listeners accept.
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal', 'HTMLFormElement', 'SubmitEvent']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownHintPopover } = await import('./markdown-hint-popover'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

async function mount(props: Partial<import('./markdown-hint-popover').MarkdownHintPopoverProps> = {}) {
  const applied: string[] = []
  root = createRoot(container)
  const next = root
  await act(async () =>
    next.render(
      <MarkdownHintPopover
        open
        anchor={container}
        text=''
        onApply={(text) => {
          applied.push(text)
        }}
        onCancel={() => {}}
        {...props}
      />,
    ),
  )
  return applied
}

// Asserted as booleans and strings, never as elements: printing a jsdom
// element walks the whole window and stalls the run.
const field = () =>
  [...document.querySelectorAll('label')].find((each) => each.textContent === 'Hint')?.control as
    | HTMLInputElement
    | undefined
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((each) => each.textContent === name) as HTMLButtonElement | undefined

async function type(value: string) {
  const input = field()
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input?.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('the field starts with the note passed in, and Remove is offered only for an existing hint', async () => {
  await mount({ text: 'Before the freeze' })
  assert.equal(field()?.value, 'Before the freeze')
  assert.equal(button('Remove') !== undefined, false)
})

test('Apply is offered once the note has more than whitespace, and sends it trimmed', async () => {
  const applied = await mount()
  assert.equal(button('Apply')?.disabled, true)
  await type('   ')
  assert.equal(button('Apply')?.disabled, true)
  await type('  Before the freeze  ')
  await act(async () => button('Apply')?.click())
  assert.deepEqual(applied, ['Before the freeze'])
})

test('Remove reports the press', async () => {
  let removed = 0
  await mount({
    text: 'Note',
    onRemove: () => {
      removed += 1
    },
  })
  await act(async () => button('Remove')?.click())
  assert.equal(removed, 1)
})
