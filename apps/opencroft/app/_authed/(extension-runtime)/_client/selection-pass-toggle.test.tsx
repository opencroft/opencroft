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
const { PASS_ENABLED_KEY, SelectionProvider, useSelection } = await import(
  '@/app/_authed/(extension-runtime)/_client/selection-context'
)

after(() => dom.cleanup())

type Scope = ReturnType<typeof useSelection>

// Renders the scope and hands the live context value back, so a test can drive
// it the way the toggle and a publisher do rather than through markup.
//
// `fresh` wipes the stored answer first, which is every test's starting point
// except the one mount that is meant to find what an earlier mount stored.
async function mountScope({ fresh = true } = {}): Promise<{ scope: () => Scope; unmount: () => Promise<void> }> {
  if (fresh) {
    window.localStorage.removeItem(PASS_ENABLED_KEY)
  }
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

test('the answer outlives the mounted scope, in both directions', async () => {
  // This test used to pin the opposite: a fresh provider started from the
  // default, so reloading or navigating away and back turned passing on again.
  // The answer is meant to be remembered, so it now
  // persists per browser. What the old test protected, the default for someone
  // who has never answered, is still pinned by the first test in this file.
  //
  // Both directions, so a remount that happened to land on the default could
  // not pass for one that read the stored answer.
  const first = await mountScope()
  await act(async () => first.scope().togglePass())
  assert.equal(first.scope().passEnabled, false)
  await first.unmount()

  const second = await mountScope({ fresh: false })
  try {
    assert.equal(second.scope().passEnabled, false, 'a remount finds the answer held back')
    await act(async () => second.scope().togglePass())
  } finally {
    await second.unmount()
  }

  const third = await mountScope({ fresh: false })
  try {
    assert.equal(third.scope().passEnabled, true, 'and finds it turned back on')
  } finally {
    await third.unmount()
  }
})

test('two presses before a render land as two', async () => {
  // Each press flips the value it finds, not the one from the render the
  // callback was handed out in. Otherwise the second press repeats the first.
  const { scope, unmount } = await mountScope()
  try {
    const { togglePass } = scope()
    await act(async () => {
      togglePass()
      togglePass()
    })
    assert.equal(scope().passEnabled, true, 'off and back on')
    assert.equal(window.localStorage.getItem(PASS_ENABLED_KEY), 'true', 'and storage agrees')
  } finally {
    await unmount()
  }
})

test('the answer is written where a reload reads it', async () => {
  // A reload is a mount with nothing in memory, so storage is the only thing
  // that can carry the answer across it. Both halves: what a press writes, and
  // what a mount makes of a value it did not write itself.
  const first = await mountScope()
  await act(async () => first.scope().togglePass())
  assert.equal(window.localStorage.getItem(PASS_ENABLED_KEY), 'false', 'the press is stored')
  await first.unmount()

  window.localStorage.removeItem(PASS_ENABLED_KEY)
  window.localStorage.setItem(PASS_ENABLED_KEY, 'false')
  const second = await mountScope({ fresh: false })
  try {
    assert.equal(second.scope().passEnabled, false, 'a stored "off" is restored on mount')
  } finally {
    await second.unmount()
  }
})
