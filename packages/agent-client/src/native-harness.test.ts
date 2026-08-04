import assert from 'node:assert/strict'
import test from 'node:test'

import { CANCELLED, raceAbort } from './native-harness'

// raceAbort backs the permission gate a tool call waits on: without it, a
// promise that eventually resolves after its turn was cancelled would still
// let the caller proceed as if nothing had happened.
test('resolves to the promise value when it settles before the signal aborts', async () => {
  const controller = new AbortController()
  const result = await raceAbort(Promise.resolve('allowed'), controller.signal)
  assert.equal(result, 'allowed')
})

test('resolves to CANCELLED when the signal aborts before the promise settles, and ignores the late settlement', async () => {
  const controller = new AbortController()
  let settleLate: (value: string) => void = () => {}
  const late = new Promise<string>((resolve) => {
    settleLate = resolve
  })

  const raced = raceAbort(late, controller.signal)
  controller.abort()
  assert.equal(await raced, CANCELLED)

  // The late resolution must not throw or otherwise surface once nothing is
  // listening for it — this simulates a permission response arriving after
  // the turn that asked for it has already moved on.
  settleLate('allowed-too-late')
})

test('an already-aborted signal short-circuits without waiting on the promise at all', async () => {
  const controller = new AbortController()
  controller.abort()
  const neverSettles = new Promise<string>(() => {})
  const result = await raceAbort(neverSettles, controller.signal)
  assert.equal(result, CANCELLED)
})

test('a rejection before abort propagates as a rejection, not as CANCELLED', async () => {
  const controller = new AbortController()
  await assert.rejects(raceAbort(Promise.reject(new Error('boom')), controller.signal), /boom/)
})

test('with no signal at all, the promise is returned untouched', async () => {
  const result = await raceAbort(Promise.resolve('value'), undefined)
  assert.equal(result, 'value')
})
