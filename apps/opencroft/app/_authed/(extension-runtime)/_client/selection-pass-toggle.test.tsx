// Whether selections are passed is the READER's answer, and nothing a
// publisher does may move it.
//
// This file used to pin the opposite rule. Setting a selection reset the flag
// to true, on the reasoning that picking something states the intent to send
// it — and a `key` on the selection existed so that a publisher republishing
// the same thing (a canvas node whose data refreshes while it stays selected)
// would not trip that reset under a reader who had turned passing off.
//
// What that reset protected was a reader who could not tell passing was off:
// the control only existed while something was selected, so an inherited "off"
// made the quotation silently inert. The control now stands on the panel
// whether or not anything is selected, so its own state is that notice, and
// the protection lives there instead. The reset is gone, and `key` with it —
// it had no other reader.
//
// So the tests below are the same population as before, asserting the opposite
// outcome: a fresh publish, a republish, a different selection, and a clear
// followed by a re-select. Plus the case the old rule made unreachable, which
// is setting the answer before selecting anything at all.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, useEffect } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SelectionProvider, useSelection } = await import('@/app/_authed/(extension-runtime)/_client/selection-context')

after(() => dom.cleanup())

type Scope = ReturnType<typeof useSelection>

// Renders the scope and hands the live context value back, so a test can drive
// it the way the toggle and a publisher do rather than through markup.
async function mountScope(): Promise<{ scope: () => Scope; unmount: () => Promise<void> }> {
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
      </SelectionProvider>,
    )
  })
  return {
    scope: () => {
      assert.ok(latest, 'the scope rendered')
      return latest
    },
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test('a scope passes by default, before anyone has said anything', async () => {
  const { scope, unmount } = await mountScope()
  try {
    assert.equal(scope().passEnabled, true, 'the default is to send what is selected')
    assert.equal(scope().selection, null, 'and it holds before there is any selection to hold an opinion about')
  } finally {
    await unmount()
  }
})

test('nothing a publisher does moves the answer', async () => {
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().setSelection({ label: 'A', content: 'a' }))
    await act(async () => scope().togglePass())
    assert.equal(scope().passEnabled, false, 'the reader turned passing off')

    // Every shape of publish the old rule distinguished between, one after
    // another. None of them is the reader, so none of them may answer for one.
    await act(async () => scope().setSelection({ label: 'A', content: 'a2' }))
    assert.equal(scope().passEnabled, false, 'a republish of the same thing with fresh content')

    await act(async () => scope().setSelection({ label: 'B', content: 'b' }))
    assert.equal(scope().passEnabled, false, 'something else selected')

    await act(async () => scope().setSelection(null))
    assert.equal(scope().passEnabled, false, 'deselected')

    await act(async () => scope().setSelection({ label: 'A', content: 'a' }))
    assert.equal(scope().passEnabled, false, 'and the first thing selected again')
  } finally {
    await unmount()
  }
})

test('the publisher still owns the selection itself', async () => {
  // The other half of the same independence, and the one that would break
  // quietly: holding passing back must not stop a publisher replacing or
  // dropping what is selected.
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().togglePass())
    await act(async () => scope().setSelection({ label: 'A', content: 'a' }))
    assert.equal(scope().selection?.content, 'a')

    await act(async () => scope().setSelection({ label: 'B', content: 'b' }))
    assert.equal(scope().selection?.label, 'B', 'replaced')

    await act(async () => scope().clearSelection())
    assert.equal(scope().selection, null, 'and dropped')
  } finally {
    await unmount()
  }
})

test('the answer can be given before anything is selected, and the next selection obeys it', async () => {
  // Unreachable under the old rule twice over: the control did not exist with
  // nothing selected, and the first publish would have reset the flag anyway.
  // It is the whole point of putting the control on the panel permanently.
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().togglePass())
    assert.equal(scope().passEnabled, false, 'held back with nothing selected yet')

    await act(async () => scope().setSelection({ label: 'A', content: 'a' }))
    assert.equal(scope().passEnabled, false, 'the selection arrives held back, as asked')
    assert.equal(scope().selection?.label, 'A', 'and it is still selected — held back is not discarded')
  } finally {
    await unmount()
  }
})

test('the answer belongs to the mounted scope and does not outlive it', async () => {
  // A standing preference, but standing within the surface that asked for it.
  // Navigating away unmounts the provider, and a fresh one starts from the
  // default — the same rule the selection itself has always followed. Pinned
  // because "standing" invites someone to persist it, and that is a decision
  // rather than a tidy-up.
  const first = await mountScope()
  await act(async () => first.scope().togglePass())
  assert.equal(first.scope().passEnabled, false)
  await first.unmount()

  const second = await mountScope()
  try {
    assert.equal(second.scope().passEnabled, true, 'a new scope starts from the default')
  } finally {
    await second.unmount()
  }
})
