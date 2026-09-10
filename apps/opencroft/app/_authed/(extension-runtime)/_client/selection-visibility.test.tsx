// The selection's two parts, and the one flag standing behind both.
//
// The quotation above the composer and the toggle beside the readouts are
// separate components in separate places, and what makes them one feature is
// that they read the same flag. That is the thing worth pinning: a change that
// wires either of them to its own state would leave a composer whose quotation
// and whose switch disagree, and both halves would look right on their own.
//
// Driven through the rendered button rather than by calling the scope's
// `togglePass` directly. The sibling `selection-pass-toggle.test.tsx` covers
// what that function does; what is unproven here is the wiring above it — that
// a press reaches it at all, and that the quotation is what answers.
//
// The press must not touch the selection. Hiding it is a decision about this
// message; the selection belongs to whatever published it, and a control that
// quietly dropped it would be a second clearing mechanism wearing an eye.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SelectionProvider, useSelection } = await import('@/app/_authed/(extension-runtime)/_client/selection-context')
const { SelectionBadge } = await import('@/app/_authed/(extension-runtime)/_client/selection-badge')
const { SelectionToggle } = await import('@/app/_authed/(extension-runtime)/_client/selection-toggle')

after(() => dom.cleanup())

type Scope = ReturnType<typeof useSelection>

const LABEL = 'app-shell.tsx'
const CONTENT = 'Repository: myrepo\nFile: app/app-shell.tsx:42'

// Both parts mounted in one scope, exactly as a composer mounts them: the
// quotation in the row above the input, the toggle in the action row below it.
// Their order here is the composer's order, and nothing in either depends on it.
async function mount(): Promise<{
  scope: () => Scope
  quote: () => Element | null
  toggle: () => Element | null
  press: () => Promise<void>
  unmount: () => Promise<void>
}> {
  let latest: Scope | null = null
  function Probe(): ReactNode {
    const value = useSelection()
    useEffect(() => {
      latest = value
    })
    latest = value
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(
      <SelectionProvider>
        <Probe />
        <SelectionBadge />
        <SelectionToggle />
      </SelectionProvider>,
    )
  })
  const toggle = () => dom.container.querySelector('button[aria-pressed]')
  return {
    scope: () => {
      assert.ok(latest, 'the scope rendered')
      return latest
    },
    quote: () => dom.container.querySelector('blockquote'),
    toggle,
    press: async () => {
      const button = toggle()
      assert.ok(button, 'the toggle is on screen to be pressed')
      await act(async () => {
        ;(button as HTMLElement).click()
      })
    },
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test('with nothing selected the quotation stays away and the switch still stands', async () => {
  // The two halves part company here, and this is the only place they do. There
  // is nothing to quote, but there is somewhere to keep an answer — so the
  // reader can settle it before selecting anything rather than being asked at
  // the moment they are busy selecting something.
  const view = await mount()
  assert.equal(view.quote(), null, 'no selection, no quotation')
  assert.ok(view.toggle(), 'the switch is on the panel regardless')
  assert.equal(view.toggle()?.getAttribute('aria-pressed'), 'true', 'and it starts from the default')
  await view.unmount()
})

test('an answer given before selecting anything is the one the selection arrives under', async () => {
  const view = await mount()
  await view.press()
  assert.equal(view.toggle()?.getAttribute('aria-pressed'), 'false', 'held back, with nothing selected yet')

  await act(async () => view.scope().setSelection({ label: LABEL, content: CONTENT }))
  assert.equal(view.quote(), null, 'the selection arrives held back rather than overriding the answer')
  assert.equal(view.scope().selection?.label, LABEL, 'held back is not discarded — it is there to be shown')

  await view.press()
  assert.equal(view.quote()?.textContent, LABEL, 'and one press shows it')
  await view.unmount()
})

test('a selection is quoted above the composer, by its label and not its content', async () => {
  const view = await mount()
  await act(async () => view.scope().setSelection({ label: LABEL, content: CONTENT }))

  const quote = view.quote()
  assert.ok(quote, 'the selection is quoted')
  assert.equal(quote.textContent, LABEL)
  // What the agent receives is the host's business. It must not reach the
  // reader through the quotation, and not through an attribute on it either.
  assert.ok(!dom.container.innerHTML.includes('Repository: myrepo'), 'the content stays out of the markup')
  await view.unmount()
})

test('pressing the toggle hides the quotation, and pressing it again brings the same one back', async () => {
  const view = await mount()
  await act(async () => view.scope().setSelection({ label: LABEL, content: CONTENT }))
  const published = view.scope().selection
  assert.equal(view.toggle()?.getAttribute('aria-pressed'), 'true', 'a fresh selection starts included')

  await view.press()
  assert.equal(view.quote(), null, 'held back means not quoted here')
  assert.ok(view.toggle(), 'the toggle stays — it is how the selection comes back')
  assert.equal(view.toggle()?.getAttribute('aria-pressed'), 'false')
  // The whole of the removal requirement, stated as a fact about the scope
  // rather than about the markup: hiding is not discarding, and the same object
  // is still there to be brought back.
  assert.equal(view.scope().selection, published, 'the selection itself is untouched')

  await view.press()
  assert.equal(view.quote()?.textContent, LABEL, 'the same selection returns, unchanged')
  assert.equal(view.scope().selection, published)
  await view.unmount()
})

test('the composer offers no way to discard the selection', async () => {
  const view = await mount()
  await act(async () => view.scope().setSelection({ label: LABEL, content: CONTENT }))

  // The positive control for the query, so the negative below cannot pass by
  // asking wrongly: the same lookup finds the one labelled control that IS
  // expected here.
  const labelled = [...dom.container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '')
  assert.ok(
    labelled.some((name) => name.includes(LABEL)),
    `the toggle's own label was not found among ${JSON.stringify(labelled)}`,
  )
  assert.ok(
    !labelled.some((name) => name.toLowerCase().includes('clear')),
    `a clear control is still offered: ${JSON.stringify(labelled)}`,
  )
  await view.unmount()
})
