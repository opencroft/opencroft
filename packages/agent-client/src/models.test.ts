import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { discoverModels, listOpenAiModels } from './models'

// The window is a vendor extension — the base OpenAI /models response has no
// such field — so the parsing is the part that has to be right: believe a real
// number, and treat anything else as "not reported" rather than coercing it.

function respondWith(data: unknown, ok = true) {
  mock.method(globalThis, 'fetch', async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Server Error',
    json: async () => ({ data }),
  }))
}

test.afterEach(() => mock.restoreAll())

test('the window is read from whichever field the endpoint uses', async () => {
  respondWith([
    { id: 'a', context_length: 200000 },
    { id: 'b', context_window: 128000 },
    { id: 'c', max_model_len: 32768 },
    { id: 'd', max_input_tokens: 1000000 },
  ])
  const models = await listOpenAiModels('https://example.test/v1')
  assert.deepEqual(
    models.map((m) => m.contextWindow),
    [200000, 128000, 32768, 1000000],
  )
})

test('a model reporting no window is left unknown rather than defaulted', async () => {
  respondWith([{ id: 'plain' }])
  const [model] = await listOpenAiModels('https://example.test/v1')
  assert.equal(model.contextWindow, undefined)
})

test('a value that is not a positive whole number is not believed', async () => {
  respondWith([
    { id: 'zero', context_length: 0 },
    { id: 'negative', context_length: -1 },
    { id: 'fractional', context_length: 1.5 },
    { id: 'string', context_length: '200000' },
  ])
  const models = await listOpenAiModels('https://example.test/v1')
  assert.deepEqual(
    models.map((m) => m.contextWindow),
    [undefined, undefined, undefined, undefined],
  )
})

test('entries without a usable id are dropped, and the rest come back sorted', async () => {
  respondWith([{ id: 'zeta' }, {}, { id: '' }, { id: 'alpha' }, null])
  const models = await listOpenAiModels('https://example.test/v1')
  assert.deepEqual(
    models.map((m) => m.id),
    ['alpha', 'zeta'],
  )
})

test('an unreachable endpoint reports nothing rather than failing the caller', async () => {
  respondWith([], false)
  assert.deepEqual(await discoverModels('https://example.test/v1'), [])
})

test('discovery passes the endpoint answer through when it succeeds', async () => {
  respondWith([{ id: 'other', context_length: 200000 }])
  assert.deepEqual(await discoverModels('https://example.test/v1'), [{ id: 'other', contextWindow: 200000 }])
})
