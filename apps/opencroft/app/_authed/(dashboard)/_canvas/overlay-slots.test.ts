// Publishing into an overlay slot must cost a render, not the application.
//
// A consumer that hands over a freshly-created node every render used to be
// fatal: writing a slot rebuilt the manager, which re-rendered every holder of
// it — the publisher included — which built another node and wrote again, until
// React gave up with "Maximum update depth exceeded". Reference stability was
// therefore a requirement of the API, enforced by hand at every call site, with
// a hung app as the penalty for missing once.
//
// These render against a real DOM because that is the only way to see it: the
// publish happens in a layout effect, and the loop needs renders to happen.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { createElement, useState } = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { OverlayProvider, useOverlay, useOverlaySlotValues } = await import('./overlay-context')

after(() => dom.cleanup())

interface Harness {
  publisherRenders: number
  painterRenders: number
  painted: unknown
  failure: string | null
  bump: (() => void) | null
}

/**
 * Mount a publisher that never reuses its node, plus the surface that paints
 * what it publishes.
 */
async function mountUnstablePublisher(): Promise<Harness> {
  const state: Harness = { publisherRenders: 0, painterRenders: 0, painted: null, failure: null, bump: null }

  function UnstablePublisher() {
    state.publisherRenders++
    const [, setTick] = useState(0)
    state.bump = () => setTick((t) => t + 1)
    // A brand new element on every render — the thing every accommodation in
    // the tree exists to avoid having to guarantee.
    useOverlay({ content: createElement('div', null, 'panel') })
    return null
  }

  function Painter() {
    state.painterRenders++
    state.painted = useOverlaySlotValues().content
    return null
  }

  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })

  const realError = console.error
  console.error = (...args: unknown[]) => {
    const text = String(args[0] ?? '')
    if (text.includes('Maximum update depth')) {
      state.failure = text
    }
  }
  try {
    await act(async () => {
      root.render(
        createElement(OverlayProvider, null, createElement(UnstablePublisher, null), createElement(Painter, null)),
      )
    })
  } catch (error) {
    state.failure = String(error)
  } finally {
    console.error = realError
  }
  return state
}

test('an unstable slot node does not take the application down', async () => {
  const harness = await mountUnstablePublisher()

  assert.equal(harness.failure, null, `publishing an unstable node must not fail: ${harness.failure}`)
  // The publisher must not be re-rendered by its own write. One render means
  // the feedback path is severed, not merely damped.
  assert.equal(harness.publisherRenders, 1, 'writing a slot must not re-render the writer')
})

test('the published node still reaches the surface that paints it', async () => {
  const harness = await mountUnstablePublisher()

  assert.notEqual(harness.painted, null, 'the published node must reach the painter')
  assert.equal(harness.failure, null)
})

test('a publisher that re-renders for its own reasons republishes without looping', async () => {
  // Severing the loop must not mean the slot goes stale: a genuine re-render of
  // the publisher still has to reach the overlay.
  const harness = await mountUnstablePublisher()
  const before = harness.painterRenders

  await act(async () => {
    harness.bump?.()
  })

  assert.equal(harness.failure, null)
  assert.equal(harness.publisherRenders, 2, 'the publisher renders once more, because it asked to')
  assert.ok(harness.painterRenders > before, 'and the new node reaches the painter')
})

// The header slot is reachable through the same hook extensions are handed, not
// only through the canvas's own components. An extension overlay that wants a
// titlebar has nowhere else to put one, so this is the difference between the
// slot existing and the slot being usable.
test('a node published into the header slot reaches the painter', async () => {
  let painted: unknown = null

  function HeaderPublisher() {
    useOverlay({ header: createElement('div', null, 'titlebar') })
    return null
  }

  function Painter() {
    painted = useOverlaySlotValues().header
    return null
  }

  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })

  await act(async () => {
    root.render(
      createElement(OverlayProvider, null, createElement(HeaderPublisher, null), createElement(Painter, null)),
    )
  })

  assert.notEqual(painted, null, 'a header published through useOverlay must reach the painter')
})
