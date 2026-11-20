import assert from 'node:assert/strict'
import test from 'node:test'

import { currentRunEvents, withRunEvent } from './run-scope'

test('outside every run there is no scope', () => {
  assert.equal(currentRunEvents(), undefined)
})

test('a dispatch inside a run sees the events dispatched before it, its own replacing an earlier one of the same node', async () => {
  await withRunEvent('route', { body: 1 }, async () => {
    await withRunEvent('switch', { body: 1 }, async () => {
      assert.deepEqual(Object.fromEntries(currentRunEvents() ?? []), { route: { body: 1 }, switch: { body: 1 } })
      await withRunEvent('switch', { body: 2 }, async () => {
        assert.deepEqual(currentRunEvents()?.get('switch'), { body: 2 })
      })
      assert.deepEqual(currentRunEvents()?.get('switch'), { body: 1 }, 'the inner run leaves the outer as it was')
    })
    assert.equal(currentRunEvents()?.has('switch'), false)
  })
  assert.equal(currentRunEvents(), undefined)
})

test('concurrent runs each see their own event across awaits', async () => {
  const seen = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      withRunEvent('route', { n: i }, async () => {
        // biome-ignore lint/plugin/noTestFixedTime: staggers the concurrent runs so their awaits interleave; the delay is an input, not a wait
        await new Promise((resolve) => setTimeout(resolve, (20 - i) % 7))
        return (currentRunEvents()?.get('route') as { n: number }).n
      }),
    ),
  )
  assert.deepEqual(
    seen,
    Array.from({ length: 20 }, (_, i) => i),
  )
})
