// Turning passing OFF is a decision, and a republish must not undo it.
//
// The selection scope resets `passEnabled` whenever a selection is set, which
// is right for a NEW selection: picking something is the statement of intent to
// send it. It is wrong for a republish of the same thing. A canvas node's data
// changes on its own while it stays selected, so without a way to tell the two
// apart, a reader who turned passing off has it switched back on by something
// they did not do -- and the next message carries what they declined to send.
//
// The publisher says which case it is by supplying a stable `key`. No key means
// every publish is a new selection, which is the behaviour extensions had
// before the field existed, so the first test here is the compatibility one.

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
// it the way the badge and a publisher do rather than through markup.
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

test('an unkeyed publish is always a new selection, as it was before keys existed', async () => {
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().setSelection({ label: 'A', content: 'a' }))
    await act(async () => scope().togglePass())
    assert.equal(scope().passEnabled, false, 'the reader turned passing off')

    await act(async () => scope().setSelection({ label: 'A', content: 'a2' }))
    assert.equal(scope().passEnabled, true, 'with no key, every publish is a fresh selection')
  } finally {
    await unmount()
  }
})

test('a republish under the same key leaves the reader choice alone', async () => {
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().setSelection({ label: 'Node', content: 'first', key: 'node_1' }))
    await act(async () => scope().togglePass())
    assert.equal(scope().passEnabled, false)

    // What a node's own data update looks like from here: same node, new content.
    await act(async () => scope().setSelection({ label: 'Node', content: 'second', key: 'node_1' }))

    assert.equal(scope().passEnabled, false, 'passing stays off -- nobody asked for it back')
    assert.equal(scope().selection?.content, 'second', 'and the content is still refreshed')
  } finally {
    await unmount()
  }
})

test('selecting a different node is a fresh selection and passes again', async () => {
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().setSelection({ label: 'One', content: 'one', key: 'node_1' }))
    await act(async () => scope().togglePass())
    assert.equal(scope().passEnabled, false)

    await act(async () => scope().setSelection({ label: 'Two', content: 'two', key: 'node_2' }))
    assert.equal(scope().passEnabled, true, 'picking something else is a new intent to send it')
  } finally {
    await unmount()
  }
})

test('clearing and re-selecting the same node passes again', async () => {
  // Deselecting is the reader dropping the whole thing, so choosing the node
  // again is a fresh decision even though the key matches.
  const { scope, unmount } = await mountScope()
  try {
    await act(async () => scope().setSelection({ label: 'One', content: 'one', key: 'node_1' }))
    await act(async () => scope().togglePass())
    await act(async () => scope().setSelection(null))
    await act(async () => scope().setSelection({ label: 'One', content: 'one', key: 'node_1' }))
    assert.equal(scope().passEnabled, true)
  } finally {
    await unmount()
  }
})
