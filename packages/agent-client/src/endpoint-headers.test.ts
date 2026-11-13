import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'

import type { InitializeResponse } from '@agentclientprotocol/sdk'
import { generateText } from 'ai'

import { forgetEndpointModels, resolveModel, selectionModels } from './endpoint'
import { checkEndpointHeaders, headerLines, mergeHeaders } from './endpoint-headers'
import { OPENCODE_HEADER_ENV_PREFIX } from './harness-adapters'
import { buildSpawnConfig, findAdapter, findProvider, takesEndpointHeaders } from './resolve'
import type { AgentSelection } from './types'

function selection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return {
    providerId: 'openai-compatible',
    adapterId: 'native',
    model: 'small',
    apiKey: 'sk-test-key',
    cwd: '/tmp',
    baseUrl: 'https://example.test/v1',
    ...overrides,
  }
}

// ── a local fake OpenAI-compatible endpoint ────────────────────────────────

interface FakeEndpoint {
  baseUrl: string
  requests: { path: string; headers: IncomingHttpHeaders }[]
  close: () => Promise<void>
}

async function fakeEndpoint(): Promise<FakeEndpoint> {
  const requests: FakeEndpoint['requests'] = []
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers })
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'small', context_length: 8192 }] }))
        return
      }
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'small',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test.beforeEach(() => forgetEndpointModels())

test('the Custom harness sends the headers with every request to the endpoint', async () => {
  const endpoint = await fakeEndpoint()
  try {
    const sel = selection({ baseUrl: endpoint.baseUrl, headers: { 'X-Tenant': 'acme', 'CF-Access-Client-Id': 'cid' } })
    const { text } = await generateText({ model: resolveModel(sel), prompt: 'ping' })
    assert.equal(text, 'pong')
    await selectionModels(sel)

    assert.deepEqual(
      endpoint.requests.map((r) => r.path),
      ['/v1/chat/completions', '/v1/models'],
    )
    for (const request of endpoint.requests) {
      assert.equal(request.headers['x-tenant'], 'acme', request.path)
      assert.equal(request.headers['cf-access-client-id'], 'cid', request.path)
      assert.equal(request.headers.authorization, 'Bearer sk-test-key', request.path)
    }
  } finally {
    await endpoint.close()
  }
})

test("a custom authorization header replaces the key's Bearer shorthand on the wire", async () => {
  const endpoint = await fakeEndpoint()
  try {
    const sel = selection({ baseUrl: endpoint.baseUrl, headers: { authorization: 'Basic dXNlcjpwdw==' } })
    await generateText({ model: resolveModel(sel), prompt: 'ping' })
    await selectionModels(sel)

    assert.equal(endpoint.requests.length, 2)
    for (const request of endpoint.requests) {
      assert.equal(request.headers.authorization, 'Basic dXNlcjpwdw==', request.path)
    }
  } finally {
    await endpoint.close()
  }
})

test('a selection without headers sends only the key', async () => {
  const endpoint = await fakeEndpoint()
  try {
    await generateText({ model: resolveModel(selection({ baseUrl: endpoint.baseUrl })), prompt: 'ping' })
    assert.equal(endpoint.requests[0]?.headers.authorization, 'Bearer sk-test-key')
    assert.equal(endpoint.requests[0]?.headers['x-tenant'], undefined)
  } finally {
    await endpoint.close()
  }
})

// ── how each harness takes them ────────────────────────────────────────────

test('Claude Code gets them as Name: Value lines in ANTHROPIC_CUSTOM_HEADERS', () => {
  const config = buildSpawnConfig(
    selection({ providerId: 'anthropic', adapterId: 'claude', headers: { 'X-Tenant': 'acme', 'X-Other': 'b' } }),
  )
  assert.equal(config.env.ANTHROPIC_CUSTOM_HEADERS, 'X-Tenant: acme\nX-Other: b')
  assert.equal(config.env.ANTHROPIC_BASE_URL, 'https://example.test/v1')
})

test('no header variable is set for a selection without headers', () => {
  const config = buildSpawnConfig(selection({ providerId: 'anthropic', adapterId: 'claude' }))
  assert.equal('ANTHROPIC_CUSTOM_HEADERS' in config.env, false)
})

test('Codex gets them in the gateway request beside the key', () => {
  const adapter = findAdapter('codex')
  const provider = findProvider('openai-compatible')
  assert.ok(adapter?.authenticate && provider)
  const init = { protocolVersion: 1, authMethods: [{ id: 'gateway', name: 'Gateway' }] } as InitializeResponse
  const request = adapter.authenticate(
    provider,
    selection({ adapterId: 'codex', responsesApi: true, headers: { 'X-Tenant': 'acme' } }),
    init,
  )
  assert.deepEqual((request._meta?.gateway as { headers: Record<string, string> }).headers, {
    Authorization: 'Bearer sk-test-key',
    'X-Tenant': 'acme',
  })
})

test("OpenCode gets them as its provider's headers, each value read from its own variable", () => {
  const config = buildSpawnConfig(selection({ adapterId: 'opencode', headers: { 'X-Tenant': 'acme' } }))
  const document = JSON.parse(config.env.OPENCODE_CONFIG_CONTENT ?? '{}')
  const env = `${OPENCODE_HEADER_ENV_PREFIX}0`
  assert.deepEqual(document.provider['openai-compatible'].options.headers, { 'X-Tenant': `{env:${env}}` })
  assert.equal(config.env[env], 'acme')
  assert.equal(config.env.OPENCODE_CONFIG_CONTENT?.includes('acme'), false)
})

test('the harnesses that can send headers are the ones that declare it', () => {
  assert.deepEqual(
    ['native', 'claude', 'codex', 'opencode', 'claude-subscription', 'qwen', 'gemini', 'copilot'].map((id) => [
      id,
      takesEndpointHeaders(id),
    ]),
    [
      ['native', true],
      ['claude', true],
      ['codex', true],
      ['opencode', true],
      ['claude-subscription', false],
      ['qwen', false],
      ['gemini', false],
      ['copilot', false],
    ],
  )
})

// ── shapes and refusals ────────────────────────────────────────────────────

test('a header value with a line break is refused before anything is spawned', () => {
  assert.throws(
    () =>
      buildSpawnConfig(
        selection({ providerId: 'anthropic', adapterId: 'claude', headers: { 'X-Tenant': 'acme\nX-Evil: 1' } }),
      ),
    /X-Tenant.*line break/,
  )
  assert.throws(() => checkEndpointHeaders({ 'Bad Name': 'v' }), /not a valid header name/)
  assert.doesNotThrow(() => checkEndpointHeaders({ 'X-Tenant': 'a\tb' }))
})

test('merging replaces a header that differs only in case', () => {
  assert.deepEqual(mergeHeaders({ Authorization: 'Bearer k', Accept: 'x' }, { authorization: 'Basic b' }), {
    Accept: 'x',
    authorization: 'Basic b',
  })
  assert.equal(headerLines({ A: '1', B: '2' }), 'A: 1\nB: 2')
})
