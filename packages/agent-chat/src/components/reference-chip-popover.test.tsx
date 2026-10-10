// A chip with a popover, through its real gestures: a press opens the card the
// host handed over, and a right-click still opens the chip's own menu.
//
// Mounted rather than rendered to markup, because the popover and the menu
// are only in the document once their primitives have opened them.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let ReferenceChip: typeof import('./reference-chip').ReferenceChip

before(async () => {
  container = installTestDom()
  // What the popup primitives reach for beyond the shared test DOM: a rect to
  // position against, and an abort signal jsdom's own listeners accept.
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ReferenceChip } = await import('./reference-chip'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

const selected: string[] = []
const opened: string[] = []

async function mount(props: Partial<import('./reference-chip').ReferenceChipProps> = {}) {
  root = createRoot(container)
  const next = root
  await act(async () =>
    next.render(
      <ReferenceChip
        label='Ada Lovelace'
        popover={<p id='card'>@ada</p>}
        menu={[{ label: 'Copy username', onSelect: () => selected.push('Copy username') }]}
        {...props}
      />,
    ),
  )
}

// Asserted as booleans and strings, never as elements: a failing comparison
// prints its operands, and printing a jsdom element walks the whole window --
// the run stalls instead of reporting.
const chip = () => container.querySelector<HTMLElement>('button')
const card = () => document.getElementById('card')
const cardShown = () => card() !== null

test('pressing the chip opens the card it was handed, and pressing again closes it', async () => {
  await mount()
  assert.equal(cardShown(), false, 'no card before the press')
  await act(async () => chip()?.click())
  assert.equal(card()?.textContent, '@ada')
  await act(async () => chip()?.click())
  assert.equal(cardShown(), false, 'closed by the second press')
})

test('a popover takes the press: the chip is a button, not the link it was given', async () => {
  opened.length = 0
  await mount({ href: '/elsewhere', onOpen: () => opened.push('open') })
  assert.equal(container.querySelector('a') !== null, false, 'the chip is not a link')
  await act(async () => chip()?.click())
  assert.equal(cardShown(), true, 'the card opened')
  assert.deepEqual(opened, [], 'onOpen was not called')
})

test('a right-click on a chip with a popover still opens its menu', async () => {
  selected.length = 0
  await mount()
  const target = chip()
  assert.equal(target !== null, true, 'the chip is a button')
  if (!target) {
    return
  }
  await act(async () => {
    target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 2, pointerType: 'mouse' }))
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (el) => el.textContent === 'Copy username',
  )
  assert.equal(item !== undefined, true, 'the menu offers its item')
  await act(async () => item?.click())
  assert.deepEqual(selected, ['Copy username'])
  assert.equal(cardShown(), false, 'and the card did not open')
})
