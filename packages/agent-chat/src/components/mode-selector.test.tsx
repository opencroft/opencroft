// The trigger as markup, and the open menu mounted: the menu's items exist
// only once the primitive has opened it.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let ModeSelector: typeof import('./mode-selector').ModeSelector

before(async () => {
  container = installTestDom()
  // What the menu primitive reaches for beyond the shared test DOM.
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal', 'PointerEvent']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ModeSelector } = await import('./mode-selector'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

const OPTIONS = ['plan', 'manual-edits', 'turbo']
const LABELS = { turbo: 'Turbo Mode' }

// The trigger's icon: lucide names each glyph in its class list.
const triggerIcon = (markup: string) => markup.match(/<svg[^>]*class="([^"]*)"/)?.[1] ?? ''

test('an unrecognised current mode shows the plain shield in the text colour, under its agent label', () => {
  const markup = renderToStaticMarkup(
    <ModeSelector options={OPTIONS} labels={LABELS} current='turbo' onSelect={() => {}} />,
  )
  const icon = triggerIcon(markup)
  assert.match(icon, /\blucide-shield\b/, markup)
  assert.match(icon, /\btext-foreground stroke-foreground\b/)
  assert.match(markup, /aria-label="Permission mode: Turbo Mode"/)
  // No first-letter stand-in for the icon.
  assert.doesNotMatch(markup, />T</)
})

test('an unrecognised mode with no label is shown as itself', () => {
  const markup = renderToStaticMarkup(<ModeSelector options={OPTIONS} current='turbo' onSelect={() => {}} />)
  assert.match(markup, /aria-label="Permission mode: turbo"/)
})

test('a known mode keeps its own icon, colour and label whatever the labels say', () => {
  const markup = renderToStaticMarkup(
    <ModeSelector
      options={OPTIONS}
      labels={{ 'manual-edits': 'build' }}
      current='manual-edits'
      onSelect={() => {}}
    />,
  )
  const icon = triggerIcon(markup)
  assert.match(icon, /\blucide-shield-check\b/)
  assert.match(icon, /\btext-green-500\b/)
  assert.match(markup, /aria-label="Permission mode: Manual Edits"/)
})

test('a label keyed by an inherited property name is not read off the prototype', () => {
  const markup = renderToStaticMarkup(
    <ModeSelector options={['constructor']} labels={{}} current='constructor' onSelect={() => {}} />,
  )
  assert.match(markup, /aria-label="Permission mode: constructor"/)
})

async function openMenu(onSelect: (option: string) => void) {
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<ModeSelector options={OPTIONS} labels={LABELS} current='plan' onSelect={onSelect} />))
  const trigger = container.querySelector('button') as HTMLButtonElement
  await act(async () => trigger.click())
}

function item(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label)
}

test('in the menu, an unrecognised mode has the plain shield in the text colour and its agent label', async () => {
  const picked: string[] = []
  await openMenu((option) => picked.push(option))
  const turbo = item('Turbo Mode')
  assert.ok(turbo, 'no "Turbo Mode" item in the open menu')
  const icon = turbo.querySelector('svg')?.getAttribute('class') ?? ''
  assert.match(icon, /\blucide-shield\b/)
  assert.match(icon, /\btext-foreground stroke-foreground\b/)
  await act(async () => turbo.click())
  // What is handed back is the option, not its label.
  assert.deepEqual(picked, ['turbo'])
})
