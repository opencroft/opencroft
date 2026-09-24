// The toggle as the `render` element of a parent that draws no element of its own.
//
// A tooltip trigger, a menu trigger, anything that takes a `render` element: it
// renders that element in its place and merges onto it the props, the ref and
// the handlers it needed an element for. The child only ever sees them if it
// spreads what it was not asked about, and only keeps the parent working if it
// CALLS an injected handler rather than declaring its own over the top. Both
// halves fail silently — no error, no warning, a trigger wired to nothing —
// which is why they are pinned here rather than left to a reviewer to notice
// on the day someone adds the tooltip.
//
// Driven through Base UI's `useRender`, which is not a stand-in for the
// mechanism: it IS the mechanism. Every Base UI trigger, and the shared Button
// in this repo, composes its `render` element through exactly this hook, so a
// control that survives here survives every trigger built the same way.
//
// It lives beside the app's own selection tests because this is where the DOM
// harness is; the component itself is in the chat package, which renders its
// tests to static markup and so cannot fire a press at all.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactElement, Ref } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createRef } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useRender } = await import('@base-ui/react/use-render')
const { SelectionToggle } = await import('agent-chat/components/selection-toggle')

after(() => dom.cleanup())

const LABEL = 'app-shell.tsx'

// A trigger reduced to its composition: it renders the element it is given and
// hands it the four things a real trigger injects — a handler it needs called,
// a state attribute it draws from (`data-popup-open` is what Base UI's popup
// triggers set while open), the accessible relationship it sets up between the
// control and whatever it opens, and the ref it positions and focuses by.
function Trigger({
  render,
  onPress,
  triggerRef,
}: {
  render: ReactElement
  onPress: () => void
  triggerRef: Ref<HTMLElement>
}) {
  return useRender({
    render,
    ref: triggerRef,
    props: { onClick: onPress, 'data-popup-open': '', 'aria-describedby': 'tip' },
  })
}

async function mountUnderTrigger(seen: string[]): Promise<{
  button: () => HTMLButtonElement
  ref: { current: HTMLElement | null }
  press: () => Promise<void>
  unmount: () => Promise<void>
}> {
  const root = createRoot(dom.container)
  const ref = createRef<HTMLElement>()
  await act(async () => {
    root.render(
      <Trigger
        onPress={() => seen.push('trigger')}
        triggerRef={ref}
        render={<SelectionToggle label={LABEL} included onToggle={() => seen.push('toggle')} />}
      />,
    )
  })
  const button = () => {
    const found = dom.container.querySelector('button')
    assert.ok(found, 'the toggle rendered')
    return found as HTMLButtonElement
  }
  return {
    button,
    ref,
    press: async () => {
      await act(async () => {
        button().click()
      })
    },
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test("a wrapping trigger's handler runs, and so does the toggle's own", async () => {
  const seen: string[] = []
  const view = await mountUnderTrigger(seen)

  await view.press()
  // Order is part of the claim, not incidental: the wrapper listens for its own
  // reasons — open a menu, show a tip — and those reasons do not wait on what
  // this control decides to do about the selection.
  assert.deepEqual(seen, ['trigger', 'toggle'])
  await view.unmount()
})

test("a wrapping trigger's attributes and ref reach the control", async () => {
  const view = await mountUnderTrigger([])

  const button = view.button()
  assert.equal(button.getAttribute('data-popup-open'), '', 'the trigger can draw its own state')
  assert.equal(button.getAttribute('aria-describedby'), 'tip', 'the control is tied to what the trigger opens')
  assert.equal(view.ref.current, button, "the trigger's ref lands on the control's element")
  await view.unmount()
})

test('what the toggle knows about itself still wins', async () => {
  const view = await mountUnderTrigger([])

  // The other half of the contract, and the reason the spread goes first: the
  // pressed state and the wording describe a fact the wrapper does not have.
  const button = view.button()
  assert.equal(button.getAttribute('aria-pressed'), 'true')
  assert.ok(button.getAttribute('aria-label')?.includes(LABEL), 'the control still names its own selection')
  await view.unmount()
})
