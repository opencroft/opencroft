import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { connectionKey, createAgentClient } from './agent-client'
import { CODEX_DEFAULT_BASE_URL, HARNESS_ADAPTERS } from './harness-adapters'
import { adaptersForProvider, buildSpawnConfig, findAdapter, findProvider } from './resolve'
import type { AgentSelection, ChatEvent } from './types'

// The Codex adapter, checked without a key: the adapter's spawn
// and auth contract against codex-acp 1.13.1 as read from its source, and the
// engine against a fake agent that enforces that contract (test-fixtures/
// fake-codex-agent.mjs).

const KEY = 'sk-test-DO-NOT-LEAK-0123456789abcdef'

function codexSelection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return {
    providerId: 'openai',
    adapterId: 'codex',
    model: 'gpt-5-codex',
    apiKey: KEY,
    cwd: '/work/agent',
    ...overrides,
  }
}

// ── the adapter entry ───────────────────────────────────────────────────────

test('codex spawns the pinned agentclientprotocol adapter with a hermetic home and no base-url/model env', () => {
  const config = buildSpawnConfig(codexSelection())
  assert.equal(config.command, 'npx')
  assert.deepEqual(config.args, ['-y', '@agentclientprotocol/codex-acp@1.13.1'])
  assert.equal(config.env.CODEX_API_KEY, KEY)
  assert.equal(config.env.NO_BROWSER, '1')
  // Relative to the workdir the harness starts in, so it never falls back to ~/.codex.
  assert.equal(config.env.CODEX_HOME, '.harness-home/codex')
  assert.deepEqual(config.ensureDirs, ['.harness-home/codex'])
  assert.equal(config.env.OPENAI_BASE_URL, undefined, 'codex-acp ignores it; the endpoint rides authenticate')
  assert.equal(config.env.OPENAI_MODEL, undefined)
  assert.deepEqual(JSON.parse(config.env.CODEX_CONFIG), { model: 'gpt-5-codex' })
})

test('a host-owned harness home is used when the host gives one', () => {
  const config = buildSpawnConfig(codexSelection({ harnessHome: '/data/harness-home/agent-a/' }))
  assert.equal(config.env.CODEX_HOME, '/data/harness-home/agent-a/codex')
})

test('a model[effort] id is split into the model and Codex reasoning effort', () => {
  const config = buildSpawnConfig(codexSelection({ model: 'gpt-5.2-codex[high]' }))
  assert.deepEqual(JSON.parse(config.env.CODEX_CONFIG), { model: 'gpt-5.2-codex', model_reasoning_effort: 'high' })
  assert.equal(buildSpawnConfig(codexSelection({ model: '' })).env.CODEX_CONFIG, undefined)
})

test('a container spawn creates the harness home inside the container, after entering the workdir', () => {
  const config = buildSpawnConfig(codexSelection({ containerName: 'agents', cwd: '/agents/a' }))
  assert.equal(config.command, 'docker')
  assert.equal(config.ensureDirs, undefined, 'container paths are never created on the host')
  const script = config.args[config.args.indexOf('sh') + 2]
  assert.equal(script, "mkdir -p '/agents/a' && cd '/agents/a' && mkdir -p '.harness-home/codex' && exec \"$0\" \"$@\"")
  assert.ok(config.args.includes('CODEX_HOME'), 'forwarded by name')
})

test('Codex is offered for OpenAI, and for a compatible endpoint only when it opts into the Responses API', () => {
  const ids = (providerId: string, responsesApi?: boolean) =>
    adaptersForProvider(providerId, { responsesApi }).map((adapter) => adapter.id)
  assert.ok(ids('openai').includes('codex'))
  assert.ok(!ids('openai-compatible').includes('codex'))
  assert.ok(ids('openai-compatible', true).includes('codex'))
  assert.ok(!ids('dashscope').includes('codex'))
  assert.ok(!ids('anthropic', true).includes('codex'), 'no OpenAI-compatible endpoint to opt in')
  // The opt-in widens nothing else.
  assert.deepEqual(
    ids('openai-compatible', true).filter((id) => id !== 'codex'),
    ids('openai-compatible'),
  )
})

// ── the gateway authenticate request ───────────────────────────────────────

const gatewayInit = {
  protocolVersion: 1,
  authMethods: [
    { id: 'api-key', name: 'API Key' },
    { id: 'gateway', name: 'Gateway' },
  ],
}

function codexAuth(selection: AgentSelection, init: unknown = gatewayInit) {
  const adapter = findAdapter('codex')
  const provider = findProvider(selection.providerId)
  assert.ok(adapter?.authenticate && provider)
  return adapter.authenticate(provider, selection, init as never)
}

test('the gateway request carries the endpoint and the key as a Bearer header', () => {
  assert.deepEqual(codexAuth(codexSelection()), {
    methodId: 'gateway',
    _meta: {
      gateway: { baseUrl: CODEX_DEFAULT_BASE_URL, headers: { Authorization: `Bearer ${KEY}` }, providerName: 'OpenAI' },
    },
  })
  const custom = codexAuth(
    codexSelection({ providerId: 'openai-compatible', baseUrl: 'https://llm.example/v1', responsesApi: true }),
  )
  assert.equal((custom._meta as { gateway: { baseUrl: string } }).gateway.baseUrl, 'https://llm.example/v1')
})

test('no key, or no gateway method advertised, is a clear error before anything is sent', () => {
  assert.throws(() => codexAuth(codexSelection({ apiKey: '' })), /Codex needs an API key/)
  assert.throws(
    () => codexAuth(codexSelection(), { protocolVersion: 1, authMethods: [{ id: 'api-key', name: 'API Key' }] }),
    /does not offer gateway authentication/,
  )
})

test('the connection key is a digest that never holds the key, and separates endpoints', () => {
  const key = connectionKey(codexSelection())
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.ok(!key.includes(KEY))
  assert.notEqual(key, connectionKey(codexSelection({ baseUrl: 'https://other.example/v1' })))
  assert.notEqual(key, connectionKey(codexSelection({ apiKey: `${KEY}-rotated` })))
})

// ── the engine against a fake codex-acp ────────────────────────────────────

const FAKE_AGENT = fileURLToPath(new URL('./test-fixtures/fake-codex-agent.mjs', import.meta.url))

interface LoggedRequest {
  method: string
  params: Record<string, unknown>
  cwd?: string
  env?: Record<string, string | null>
}

// Points an adapter entry at the fake agent for one test, and collects the
// agent's request log, every emitted event and everything printed to
// console.error — the three places a key could leak to.
async function withFakeAgent(
  adapterId: string,
  mode: string,
  run: (h: {
    client: ReturnType<typeof createAgentClient>
    cwd: string
    requests: () => LoggedRequest[]
    events: ChatEvent[]
    printed: string[]
  }) => Promise<void>,
): Promise<void> {
  const adapter = HARNESS_ADAPTERS.find((entry) => entry.id === adapterId)
  assert.ok(adapter)
  const saved = { command: adapter.command, args: adapter.args }
  const dir = mkdtempSync(join(tmpdir(), 'codex-base-'))
  const logFile = join(dir, 'requests.jsonl')
  // The host creates an agent's workdir before spawning it (acp-impl.ts).
  const cwd = join(dir, 'work')
  mkdirSync(cwd)
  const savedEnv = { log: process.env.FAKE_AGENT_LOG, mode: process.env.FAKE_AGENT_MODE }
  process.env.FAKE_AGENT_LOG = logFile
  process.env.FAKE_AGENT_MODE = mode
  adapter.command = process.execPath
  adapter.args = [FAKE_AGENT]
  const printed: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    printed.push(
      args.map((arg) => (arg instanceof Error ? `${arg.message} ${String(arg.cause)}` : String(arg))).join(' '),
    )
  }
  const events: ChatEvent[] = []
  const client = createAgentClient({
    onEvent: (_sessionId, event) => events.push(event),
    loadMcpServers: async () => [
      { name: 'legacy-sse', transport: 'sse', url: 'http://127.0.0.1:9/sse' },
      { name: 'files', transport: 'stdio', command: 'true' },
    ],
  })
  try {
    await run({
      client,
      cwd,
      requests: () =>
        existsSync(logFile)
          ? readFileSync(logFile, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as LoggedRequest)
          : [],
      events,
      printed,
    })
  } finally {
    await client.reset()
    console.error = originalError
    adapter.command = saved.command
    adapter.args = saved.args
    process.env.FAKE_AGENT_LOG = savedEnv.log
    process.env.FAKE_AGENT_MODE = savedEnv.mode
    if (savedEnv.log === undefined) delete process.env.FAKE_AGENT_LOG
    if (savedEnv.mode === undefined) delete process.env.FAKE_AGENT_MODE
    rmSync(dir, { recursive: true, force: true })
  }
}

function assertNoLeak(h: { events: ChatEvent[]; printed: string[] }, error?: unknown): void {
  assert.ok(!JSON.stringify(h.events).includes(KEY), 'no emitted event carries the key')
  assert.ok(!h.printed.join('\n').includes(KEY), 'nothing printed carries the key')
  if (error !== undefined) {
    assert.ok(!String((error as Error).message).includes(KEY), 'the thrown error does not carry the key')
    assert.ok(!JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(KEY))
  }
}

test('a Codex session authenticates through the gateway before session/new and gets only transports it accepts', async () => {
  await withFakeAgent('codex', '', async (h) => {
    const meta = await h.client.createSession(codexSelection({ cwd: h.cwd }))
    assert.ok(meta.id.startsWith('fake-'))
    const requests = h.requests()
    assert.deepEqual(
      requests.map((request) => request.method),
      ['initialize', 'authenticate', 'session/new'],
    )
    const [init, auth, created] = requests
    assert.deepEqual(
      (init.params.clientCapabilities as { auth?: { _meta?: unknown } }).auth?._meta,
      { gateway: true },
      'gateway auth declared on this connection',
    )
    // The harness home exists before the harness starts, inside its workdir.
    assert.equal(init.env?.CODEX_HOME, '.harness-home/codex')
    assert.ok(existsSync(join(h.cwd, '.harness-home', 'codex')))
    assert.equal(init.env?.NO_BROWSER, '1')
    assert.deepEqual(JSON.parse(init.env?.CODEX_CONFIG ?? '{}'), { model: 'gpt-5-codex' })
    assert.deepEqual(auth.params, {
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: CODEX_DEFAULT_BASE_URL,
          headers: { Authorization: `Bearer ${KEY}` },
          providerName: 'OpenAI',
        },
      },
    })
    const servers = (created.params.mcpServers as { name: string; type?: string }[]).map((server) => server.name)
    assert.ok(servers.includes('files'))
    assert.ok(!servers.includes('legacy-sse'))
    const dropped = h.events.find((event) => event.kind === 'error' && event.message.includes('legacy-sse'))
    assert.ok(dropped, 'the dropped server is reported in the chat')
    assertNoLeak(h)
  })
})

test('a rejected authenticate surfaces as an error without the key, and nothing leaks from stderr', async () => {
  await withFakeAgent('codex', 'reject-auth', async (h) => {
    const error = await h.client.createSession(codexSelection({ cwd: h.cwd })).then(
      () => assert.fail('createSession must fail'),
      (caught: unknown) => caught,
    )
    assert.match((error as Error).message, /^Codex authentication failed: /)
    assert.match((error as Error).message, /\[redacted\]/, 'the echoed header is scrubbed, not dropped silently')
    assert.ok(!h.requests().some((request) => request.method === 'session/new'))
    assertNoLeak(h, error)
  })
})

test('an agent without gateway auth fails clearly, and so does a profile without a key', async () => {
  await withFakeAgent('codex', 'no-gateway', async (h) => {
    await assert.rejects(
      h.client.createSession(codexSelection({ cwd: h.cwd })),
      /does not offer gateway authentication/,
    )
    assertNoLeak(h)
  })
  await withFakeAgent('codex', '', async (h) => {
    await assert.rejects(h.client.createSession(codexSelection({ cwd: h.cwd, apiKey: '' })), /Codex needs an API key/)
    assert.ok(!h.requests().some((request) => request.method === 'authenticate'))
  })
})

test('adapters without an authenticate hook neither declare gateway auth nor authenticate', async () => {
  await withFakeAgent('qwen', 'open', async (h) => {
    await h.client.createSession({ providerId: 'openai', adapterId: 'qwen', model: 'm', apiKey: KEY, cwd: h.cwd })
    const [init, ...rest] = h.requests()
    assert.equal((init.params.clientCapabilities as { auth?: { _meta?: unknown } }).auth?._meta, undefined)
    assert.deepEqual(
      rest.map((request) => request.method),
      ['session/new'],
    )
  })
})
