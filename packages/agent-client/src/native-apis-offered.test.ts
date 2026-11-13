import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_PROVIDERS } from './agent-providers'
import { adaptersForProvider, nativeApi, nativeApisOffered } from './resolve'

// Which APIs the Custom harness offers on each provider of the table, and so
// where the harness itself is offered. Stated over the whole table: a provider
// added later lands in the assertion below by its endpoints.

const offered = (providerId: string, responsesApi = false) =>
  nativeApisOffered(AGENT_PROVIDERS.find((provider) => provider.id === providerId) ?? { endpoints: {} }, {
    responsesApi,
  })

test('each provider offers one API per endpoint type it lists, Chat Completions first', () => {
  assert.deepEqual(offered('openai'), ['chat-completions', 'responses'])
  assert.deepEqual(offered('anthropic'), ['anthropic-messages'])
  assert.deepEqual(offered('zai'), ['chat-completions', 'anthropic-messages'])
  assert.deepEqual(offered('openrouter'), ['chat-completions', 'anthropic-messages'])
  assert.deepEqual(offered('openai-compatible'), ['chat-completions'])
  assert.deepEqual(offered('openai-compatible', true), ['chat-completions', 'responses'])
  assert.deepEqual(offered('google'), [])
  assert.deepEqual(offered('github-copilot'), [])
})

test('the Custom harness is offered exactly where its provider offers an API', () => {
  for (const provider of AGENT_PROVIDERS) {
    const custom = adaptersForProvider(provider.id).some((adapter) => adapter.id === 'native')
    assert.equal(custom, offered(provider.id).length > 0, provider.id)
  }
  // Pinned by name, so a table edit cannot empty the loop above unnoticed.
  assert.ok(adaptersForProvider('anthropic').some((adapter) => adapter.id === 'native'))
  assert.ok(!adaptersForProvider('google').some((adapter) => adapter.id === 'native'))
})

test('a named API the provider does not offer falls back to the first it does', () => {
  assert.equal(nativeApi({ providerId: 'zai', nativeApi: 'anthropic-messages' }), 'anthropic-messages')
  assert.equal(nativeApi({ providerId: 'anthropic', nativeApi: 'chat-completions' }), 'anthropic-messages')
  assert.equal(nativeApi({ providerId: 'google' }), undefined)
})
