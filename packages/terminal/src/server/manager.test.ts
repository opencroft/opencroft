// The registry must be one per process, however many copies of this package the process loads. A
// dev server runs server functions and websocket routes through separate module runners, and a
// production build can bundle the package into more than one output; each copy that made its own
// registry would hold jobs the other could never attach to.
import assert from 'node:assert/strict'
import test from 'node:test'

test('two separately loaded copies of the module share one registry and one sweep timer', async () => {
  const realSetInterval = globalThis.setInterval
  const created: ReturnType<typeof setInterval>[] = []
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = realSetInterval(...args)
    created.push(timer)
    return timer
  }) as typeof setInterval
  try {
    // A query string makes Node evaluate the file again as a distinct module instance, which is
    // what a second module runner or a second bundle amounts to.
    const first = await import(`./manager.ts?copy=first-${Date.now()}`)
    const second = await import(`./manager.ts?copy=second-${Date.now()}`)

    assert.notEqual(first, second, 'the two imports are separate module instances')
    assert.equal(first.sessionManager, second.sessionManager, 'and they hand out the same registry')
    assert.equal(created.length, 1, 'which runs one sweep timer, not one per copy')
  } finally {
    globalThis.setInterval = realSetInterval
    for (const timer of created) {
      clearInterval(timer)
    }
  }
})
