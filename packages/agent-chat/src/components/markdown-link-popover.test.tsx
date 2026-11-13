// The link popover, mounted: its fields start from what the host passes,
// Apply sends what was typed, a refused address keeps it open and says so,
// and Escape cancels.
//
// Mounted rather than rendered to markup, because a popover is only in the
// document once its primitive has opened it.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownLinkPopover: typeof import('./markdown-link-popover').MarkdownLinkPopover

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
  ;({ MarkdownLinkPopover } = await import('./markdown-link-popover'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

interface Calls {
  applied: [string, string][]
  /** Each cancel's `returnFocus`. */
  cancelled: boolean[]
}

async function mount(props: Partial<import('./markdown-link-popover').MarkdownLinkPopoverProps> = {}): Promise<Calls> {
  const calls: Calls = { applied: [], cancelled: [] }
  root = createRoot(container)
  const next = root
  await act(async () =>
    next.render(
      <MarkdownLinkPopover
        open
        anchor={container}
        text='word'
        href=''
        onApply={(text, href) => {
          calls.applied.push([text, href])
          return true
        }}
        onCancel={(returnFocus) => {
          calls.cancelled.push(returnFocus)
        }}
        {...props}
      />,
    ),
  )
  return calls
}

// Asserted as booleans and strings, never as elements: printing a jsdom
// element walks the whole window and stalls the run.
const field = (label: string) =>
  [...document.querySelectorAll('label')].find((each) => each.textContent === label)?.control as
    | HTMLInputElement
    | undefined
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((each) => each.textContent === name) as HTMLButtonElement | undefined

async function type(label: string, value: string) {
  const input = field(label)
  assert.equal(input !== undefined, true, `a ${label} field`)
  if (!input) {
    return
  }
  // React tracks the value it last set; going through the prototype's setter
  // is what makes it see a change.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('the fields start with the text and address passed in, and Remove only for an existing link', async () => {
  await mount({ text: 'the guide', href: 'https://example.com/guide' })
  assert.equal(field('Text')?.value, 'the guide')
  assert.equal(field('Link')?.value, 'https://example.com/guide')
  assert.equal(button('Remove') !== undefined, false)
})

test('Apply is offered once there is an address, and sends what was typed', async () => {
  const calls = await mount()
  assert.equal(button('Apply')?.disabled, true)
  await type('Text', 'a word')
  await type('Link', '  https://example.com  ')
  assert.equal(button('Apply')?.disabled, false)
  await act(async () => button('Apply')?.click())
  assert.deepEqual(calls.applied, [['a word', 'https://example.com']])
})

test('a refused address marks the Link field and says why', async () => {
  await mount({ onApply: () => false })
  await type('Link', 'javascript:alert(1)')
  await act(async () => button('Apply')?.click())
  assert.equal(field('Link')?.getAttribute('aria-invalid'), 'true')
  assert.equal(document.body.textContent?.includes("This address can't be used as a link."), true)
  await type('Link', 'https://example.com')
  assert.equal(field('Link')?.getAttribute('aria-invalid'), null)
})

test('Cancel and Escape both cancel and ask for focus back in the text', async () => {
  const calls = await mount()
  await act(async () => button('Cancel')?.click())
  const input = field('Link')
  await act(async () => {
    input?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  assert.deepEqual(calls.cancelled, [true, true])
})

test('Remove is offered for an existing link and reports the press', async () => {
  let removed = 0
  await mount({
    href: 'https://example.com',
    onRemove: () => {
      removed += 1
    },
  })
  await act(async () => button('Remove')?.click())
  assert.equal(removed, 1)
})

test('reopening starts from the new values, not from the last typing', async () => {
  await mount()
  await type('Link', 'https://typed.example')
  const next = root
  const render = (open: boolean) =>
    next?.render(
      <MarkdownLinkPopover
        open={open}
        anchor={container}
        text='other'
        href='https://other.example'
        onApply={() => true}
        onCancel={() => {}}
      />,
    )
  await act(async () => render(false))
  await act(async () => render(true))
  assert.equal(field('Text')?.value, 'other')
  assert.equal(field('Link')?.value, 'https://other.example')
})
