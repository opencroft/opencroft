import assert from 'node:assert/strict'
import test from 'node:test'

import { type CallFrame, currentCallStack, inCallFrame, MAX_CALL_DEPTH } from './call-stack'

const frame = (owner: string, action = 'run'): CallFrame => ({ owner, action, label: owner.toUpperCase() })

test('a frame is on the stack while its run runs, and gone after', async () => {
  const seen = await inCallFrame(frame('a'), async () => currentCallStack().map((f) => f.owner))
  assert.deepEqual(seen, ['a'])
  assert.deepEqual(currentCallStack(), [])
})

test('re-entering an action still running in the chain is refused, naming the loop', async () => {
  await assert.rejects(
    inCallFrame(frame('a'), () => inCallFrame(frame('b'), () => inCallFrame(frame('a'), async () => 'ran'))),
    /^Error: Refused a loop: A › run is already running in this chain \(A › run → B › run → A › run\)\.$/,
  )
})

test('another action of the same owner is not a loop', async () => {
  const result = await inCallFrame(frame('a', 'handle'), () => inCallFrame(frame('a', 'generate'), async () => 'ran'))
  assert.equal(result, 'ran')
})

test('the same action entered again after it finished is not a loop', async () => {
  const result = await inCallFrame(frame('chain'), async () => {
    await inCallFrame(frame('store', 'generate'), async () => 'first')
    return inCallFrame(frame('store', 'generate'), async () => 'second')
  })
  assert.equal(result, 'second')
})

test('two runs side by side each see only their own chain', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = inCallFrame(frame('a'), async () => {
    await gate
    return currentCallStack().map((f) => f.owner)
  })
  const second = inCallFrame(frame('a'), async () => {
    release()
    return currentCallStack().map((f) => f.owner)
  })
  assert.deepEqual(await Promise.all([first, second]), [['a'], ['a']])
})

test(`a chain ${MAX_CALL_DEPTH} actions deep refuses one more`, async () => {
  const nest = (depth: number): Promise<string> =>
    depth === MAX_CALL_DEPTH ? Promise.resolve('bottom') : inCallFrame(frame(`n${depth}`), () => nest(depth + 1))
  assert.equal(await nest(0), 'bottom')
  const deeper = (depth: number): Promise<string> =>
    depth > MAX_CALL_DEPTH ? Promise.resolve('bottom') : inCallFrame(frame(`n${depth}`), () => deeper(depth + 1))
  await assert.rejects(deeper(0), new RegExp(`has entered ${MAX_CALL_DEPTH} actions without finishing one`))
})
