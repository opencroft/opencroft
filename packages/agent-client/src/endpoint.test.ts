import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  forgetEndpointModels,
  reasoningProviderOptions,
  resolveBaseUrl,
  resolveSelectionContextWindow,
  selectionModels,
} from './endpoint'
import type { AgentSelection } from './types'

function selection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'small',
    apiKey: 'key',
    cwd: '/tmp',
    baseUrl: 'https://example.test/v1',
    ...overrides,
  }
}

function respondWith(data: unknown) {
  return mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ data }),
  }))
}

test.beforeEach(() => forgetEndpointModels())
test.afterEach(() => mock.restoreAll())

// ── which endpoint a selection reaches ─────────────────────────────────────

test("a selection's own base URL wins over the provider table", () => {
  assert.equal(resolveBaseUrl(selection({ providerId: 'openrouter' })), 'https://example.test/v1')
})

test('the provider table answers when the selection names no URL', () => {
  assert.equal(
    resolveBaseUrl(selection({ providerId: 'openrouter', baseUrl: undefined })),
    'https://openrouter.ai/api/v1',
  )
})

test('a provider with no OpenAI-compatible endpoint is refused, not guessed at', () => {
  assert.throws(
    () => resolveBaseUrl(selection({ providerId: 'anthropic', baseUrl: undefined })),
    /no OpenAI-compatible endpoint/,
  )
})

// ── reasoning effort ───────────────────────────────────────────────────────

// 'default' is the UI's way of saying "no preference": not a value an endpoint
// accepts, so it has to resolve to sending nothing — forwarding it would ask
// the model for an effort grade literally named after the absence of one.
// 'off' on a model with no known scale means the same, because such a model
// only thinks when asked and sending nothing already leaves it off.
test('no preference, and off with no scale to weaken, both send no reasoning option', () => {
  for (const effort of [undefined, '', 'default', 'off']) {
    assert.equal(reasoningProviderOptions(selection(), effort), undefined, `effort ${String(effort)}`)
  }
})

test('a real effort is keyed by the provider name the model was built with', () => {
  assert.deepEqual(reasoningProviderOptions(selection({ providerId: 'zai' }), 'high'), {
    zai: { reasoningEffort: 'high' },
  })
})

// `off` asks to think as little as the endpoint allows. For a model whose
// scale reaches down to `minimal` that is `minimal` — the literal floor; for
// one whose scale stops at `low`, there is nothing weaker to send, so nothing
// is (and the model's own default applies).
test('off becomes the weakest grade a model with a floor takes', () => {
  assert.deepEqual(reasoningProviderOptions(selection({ model: 'gpt-5' }), 'off'), {
    'openai-compatible': { reasoningEffort: 'minimal' },
  })
  assert.equal(reasoningProviderOptions(selection({ model: 'claude-sonnet-4' }), 'off'), undefined)
})

// The scale is read off the model the call will use, not the profile's own —
// an override can move a profile onto a scale its stored model never had.
test('off is weakened against the model the call actually uses', () => {
  assert.deepEqual(reasoningProviderOptions(selection({ model: 'claude-sonnet-4' }), 'off', 'gpt-5'), {
    'openai-compatible': { reasoningEffort: 'minimal' },
  })
})

// ── discovery, cached per endpoint rather than per session ──────────────────

// The point of these completions is fanning several out at once, so the shared
// lookup has to collapse: ten steps starting together must not each ask the
// endpoint what it serves.
test('concurrent lookups against one endpoint make a single request', async () => {
  const fetched = respondWith([{ id: 'small', context_length: 8192 }])
  const results = await Promise.all([
    selectionModels(selection()),
    selectionModels(selection()),
    selectionModels(selection()),
  ])
  assert.equal(fetched.mock.callCount(), 1)
  for (const models of results) {
    assert.deepEqual(models, [{ id: 'small', contextWindow: 8192 }])
  }
})

test('two credentials against one URL are asked separately', async () => {
  const fetched = respondWith([{ id: 'small' }])
  await selectionModels(selection({ apiKey: 'first' }))
  await selectionModels(selection({ apiKey: 'second' }))
  assert.equal(fetched.mock.callCount(), 2)
})

// discoverModels never throws: an unreachable endpoint and a silent one both
// come back as []. Caching that would let one transient failure claim, for the
// rest of the process, that this endpoint serves nothing.
test('an endpoint that reports nothing is asked again rather than remembered as empty', async () => {
  const fetched = respondWith([])
  assert.deepEqual(await selectionModels(selection()), [])
  assert.deepEqual(await selectionModels(selection()), [])
  assert.equal(fetched.mock.callCount(), 2)
})

// ── the window reported for a selection ────────────────────────────────────

test('a configured window wins: it is a deliberate override', async () => {
  const fetched = respondWith([{ id: 'small', context_length: 8192 }])
  assert.equal(await resolveSelectionContextWindow(selection({ contextWindow: 4096 })), 4096)
  assert.equal(fetched.mock.callCount(), 0)
})

test('with nothing configured the endpoint answers for the model actually in use', async () => {
  respondWith([
    { id: 'small', context_length: 8192 },
    { id: 'large', context_length: 200000 },
  ])
  assert.equal(await resolveSelectionContextWindow(selection(), 'large'), 200000)
})

test('a model the endpoint does not describe leaves the window unknown, not small', async () => {
  respondWith([{ id: 'small', context_length: 8192 }])
  assert.equal(await resolveSelectionContextWindow(selection({ model: 'unlisted' })), 0)
})
