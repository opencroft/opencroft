import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { connectionKey, createAgentClient, supportsMidTurnInput } from './agent-client'
import { AGENT_PROVIDERS } from './agent-providers'
import type { AgentConnection } from './connection'
import { foldEvents } from './fold'
import { CODEX_DEFAULT_BASE_URL, HARNESS_ADAPTERS } from './harness-adapters'
import { awaitOauthLogin, disconnectOauth, oauthLoginStatus, startOauthLogin } from './oauth-login'
import { adaptersForProvider, buildSpawnConfig, findAdapter, findProvider } from './resolve'
import type { AgentSelection, ChatEvent } from './types'

// The Codex adapters, checked without a key or an account: the adapters'
// spawn and auth contract against codex-acp 1.13.1 as read from its source,
// and the engine and the device-code sign-in against a fake agent that
// enforces that contract (test-fixtures/fake-codex-agent.mjs).

const KEY = 'sk-test-DO-NOT-LEAK-0123456789abcdef'
// What the fake agent's device-code sign-in shows; made up.
const DEVICE_URL = 'https://auth.example.test/codex/device'
const DEVICE_CODE = 'FAKE-12345'

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
  // The opt-in widens nothing but the Responses-API harnesses.
  assert.deepEqual(
    ids('openai-compatible', true).filter((id) => findAdapter(id)?.protocol !== 'openai-responses'),
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
  pid?: number
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
  process.env.FAKE_DEVICE_URL = DEVICE_URL
  process.env.FAKE_DEVICE_CODE = DEVICE_CODE
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
    delete process.env.FAKE_DEVICE_URL
    delete process.env.FAKE_DEVICE_CODE
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

// ── a harness that loses its sign-in ───────────────────────────────────────

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Sends `/logout` the way a reader would type it, and waits for its turn to end.
async function logOut(h: { client: ReturnType<typeof createAgentClient>; events: ChatEvent[] }, sessionId: string) {
  const ended = h.events.filter((event) => event.kind === 'turn_end').length
  await h.client.prompt(sessionId, '/logout', { queue: 'push', origin: { kind: 'system' } })
  await until(() => h.events.filter((event) => event.kind === 'turn_end').length > ended, 'the /logout turn to end')
}

test('a harness that lost its sign-in is retired, and the next session opens on a process that signs in again', async () => {
  await withFakeAgent('codex', '', async (h) => {
    const selection = codexSelection({ cwd: h.cwd })
    const first = await h.client.createSession(selection)
    await logOut(h, first.id)
    // The chat that signed out is closed; its harness closes sessions, so the
    // process stays up, signed out, for whoever opens the next one.
    await h.client.deleteSession(first.id)
    const second = await h.client.createSession(selection)
    const requests = h.requests()
    assert.deepEqual(
      requests.map((request) => request.method),
      [
        'initialize',
        'authenticate',
        'session/new',
        'session/prompt',
        'session/close',
        'session/new',
        'initialize',
        'authenticate',
        'session/new',
      ],
    )
    const signedOut = requests[0].pid
    const fresh = requests[6].pid
    assert.notEqual(signedOut, fresh)
    assert.equal(requests[5].pid, signedOut, 'the refusal came from the signed-out process')
    assert.equal(requests[8].pid, fresh, 'and the retry from the one that signed in again')
    assert.ok(second.id.startsWith(`fake-${fresh}-`))
    await until(() => !alive(signedOut), 'the signed-out process to exit')
    assert.ok(!h.events.some((event) => event.kind === 'error' && /sign-in/.test(event.message)), 'nothing to resend')
    assertNoLeak(h)
    // The retired process exited after its successor was stored under the
    // same key; the successor must still be the engine's to stop.
    await h.client.reset()
    await until(() => !alive(fresh), 'reset() to stop the process that replaced it')
  })
})

test('a sign-in that does not hold is retried once, then reported as a reset connection without the key', async () => {
  await withFakeAgent('codex', 'auth-lost', async (h) => {
    const error = await h.client.createSession(codexSelection({ cwd: h.cwd })).then(
      () => assert.fail('createSession must fail'),
      (caught: unknown) => caught,
    )
    assert.equal(
      (error as Error).message,
      'Codex had lost its sign-in, so its connection was reset and will sign in again: send your message again.',
    )
    const requests = h.requests()
    assert.deepEqual(
      requests.map((request) => request.method),
      ['initialize', 'authenticate', 'session/new', 'initialize', 'authenticate', 'session/new'],
    )
    assert.equal(new Set(requests.map((request) => request.pid)).size, 2)
    await until(() => requests.every((request) => !alive(request.pid)), 'both refusing processes to exit')
    assertNoLeak(h, error)
  })
})

test('resuming the only session on a signed-out harness reattaches it on a process that signs in again', async () => {
  await withFakeAgent('codex', '', async (h) => {
    const session = await h.client.createSession(codexSelection({ cwd: h.cwd }))
    await logOut(h, session.id)
    await h.client.resumeSession(session.id)
    const requests = h.requests()
    assert.deepEqual(
      requests.slice(4).map((request) => [request.method, request.pid === requests[0].pid ? 'signed-out' : 'fresh']),
      [
        ['session/resume', 'signed-out'],
        ['initialize', 'fresh'],
        ['authenticate', 'fresh'],
        ['session/resume', 'fresh'],
      ],
    )
    assert.equal((requests[7].params as { sessionId?: string }).sessionId, session.id)
    assertNoLeak(h)
  })
})

test('a signed-out harness another open session still uses is kept, and the refusal says so', async () => {
  await withFakeAgent('codex', '', async (h) => {
    const selection = codexSelection({ cwd: h.cwd })
    const open = await h.client.createSession(selection)
    await logOut(h, open.id)
    const error = await h.client.createSession(selection).then(
      () => assert.fail('createSession must fail'),
      (caught: unknown) => caught,
    )
    assert.match((error as Error).message, /^Codex had lost its sign-in, and another open session still uses/)
    const requests = h.requests()
    assert.equal(requests.filter((request) => request.method === 'initialize').length, 1, 'nothing respawned')
    assert.ok(alive(requests[0].pid), 'the open session keeps its process')
    assertNoLeak(h, error)
  })
})

test('an adapter without an authenticate hook passes a sign-in refusal through and keeps its process', async () => {
  await withFakeAgent('qwen', 'open', async (h) => {
    const selection: AgentSelection = { providerId: 'openai', adapterId: 'qwen', model: 'm', apiKey: KEY, cwd: h.cwd }
    const first = await h.client.createSession(selection)
    await logOut(h, first.id)
    await h.client.deleteSession(first.id)
    const error = await h.client.createSession(selection).then(
      () => assert.fail('createSession must fail'),
      (caught: unknown) => caught,
    )
    assert.equal((error as { code?: number }).code, -32000, 'the agent’s own error, untouched')
    const requests = h.requests()
    assert.deepEqual(
      requests.map((request) => request.method),
      ['initialize', 'session/new', 'session/prompt', 'session/close', 'session/new'],
    )
    assert.ok(alive(requests[0].pid))
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

// ── the ChatGPT-subscription variant ───────────────────────────────────────

function subscriptionSelection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return codexSelection({ adapterId: 'codex-subscription', ...overrides })
}

test('the subscription variant spawns the same pinned bridge with its own home and no key', () => {
  const config = buildSpawnConfig(subscriptionSelection({ harnessHome: '/data/harness-home/agent-a' }))
  assert.equal(config.command, 'npx')
  assert.deepEqual(config.args, ['-y', '@agentclientprotocol/codex-acp@1.13.1'])
  // Its own directory beside the key variant's, so the two logins never mix.
  assert.equal(config.env.CODEX_HOME, '/data/harness-home/agent-a/codex-subscription')
  assert.deepEqual(config.ensureDirs, ['/data/harness-home/agent-a/codex-subscription'])
  assert.equal(config.env.NO_BROWSER, '1')
  assert.deepEqual(JSON.parse(config.env.CODEX_CONFIG), { model: 'gpt-5-codex' })
  assert.ok(
    !Object.values(config.env).includes(KEY),
    'a key left on the profile travels nowhere: the ChatGPT login is the credential',
  )
  const adapter = findAdapter('codex-subscription')
  assert.equal(adapter?.authenticate, undefined)
  assert.equal(adapter?.keyEnv, undefined)
  assert.equal(adapter?.supportsOauthLogin, true)
})

test('the subscription variant is offered exactly where the key variant is', () => {
  for (const provider of AGENT_PROVIDERS) {
    for (const responsesApi of [false, true]) {
      const ids = adaptersForProvider(provider.id, { responsesApi }).map((adapter) => adapter.id)
      assert.equal(
        ids.includes('codex-subscription'),
        ids.includes('codex'),
        `${provider.id}, responsesApi ${responsesApi}`,
      )
    }
  }
  assert.ok(adaptersForProvider('openai').some((adapter) => adapter.id === 'codex-subscription'))
})

function harnessHomeOf(h: { cwd: string }): string {
  return join(dirname(h.cwd), 'harness-home')
}

test('the device-code sign-in shows the link and code, accepts, and stores the login in the agent’s home', async () => {
  await withFakeAgent('codex-subscription', '', async (h) => {
    const harnessHome = harnessHomeOf(h)
    const authFile = join(harnessHome, 'codex-subscription', 'auth.json')
    assert.deepEqual(await oauthLoginStatus('codex-subscription', { harnessHome }), {
      supported: true,
      connected: false,
    })
    const shown = await startOauthLogin('codex-subscription', { harnessHome })
    assert.ok(shown.kind === 'device-code')
    assert.match(shown.loginId, /^[0-9a-f-]{36}$/)
    assert.deepEqual(
      { ...shown, loginId: '' },
      {
        kind: 'device-code',
        loginId: '',
        verificationUrl: DEVICE_URL,
        userCode: DEVICE_CODE,
        message: `Sign in to ChatGPT and enter this code: ${DEVICE_CODE}`,
      },
    )
    assert.deepEqual(await awaitOauthLogin(shown.loginId), { ok: true })
    assert.ok(existsSync(authFile))
    const [init, auth, answer] = h.requests()
    assert.deepEqual([init.method, auth.method, answer.method], ['initialize', 'authenticate', 'elicitation/response'])
    assert.deepEqual((init.params.clientCapabilities as { elicitation?: unknown }).elicitation, { url: {} })
    assert.equal(init.env?.CODEX_HOME, join(harnessHome, 'codex-subscription'))
    assert.equal(init.env?.NO_BROWSER, '1')
    assert.deepEqual(auth.params, { methodId: 'chat-gpt-device-code' })
    assert.deepEqual(answer.params, { action: 'accept' })
    // Read once: a second read finds the flow finished.
    assert.deepEqual(await awaitOauthLogin(shown.loginId), { ok: false, error: 'Login attempt expired — start again' })

    assert.deepEqual(await oauthLoginStatus('codex-subscription', { harnessHome }), {
      supported: true,
      connected: true,
    })
    await disconnectOauth('codex-subscription', { harnessHome })
    assert.ok(!existsSync(authFile))
    assert.equal((await oauthLoginStatus('codex-subscription', { harnessHome })).connected, false)
  })
})

test('an agent that never offers the device-code sign-in fails the start clearly', async () => {
  await withFakeAgent('codex-subscription', 'no-device-code', async (h) => {
    await assert.rejects(
      startOauthLogin('codex-subscription', { harnessHome: harnessHomeOf(h) }),
      /^Error: Codex \(ChatGPT subscription\) does not offer the 'chat-gpt-device-code' sign-in/,
    )
    assert.ok(!h.requests().some((request) => request.method === 'authenticate'))
  })
})

test('a sign-in that fails after the code was shown settles with the failure and stores nothing', async () => {
  await withFakeAgent('codex-subscription', 'device-code-fails', async (h) => {
    const harnessHome = harnessHomeOf(h)
    const shown = await startOauthLogin('codex-subscription', { harnessHome })
    assert.equal(shown.kind, 'device-code')
    const result = await awaitOauthLogin((shown as { loginId: string }).loginId)
    assert.ok(!('pending' in result), 'settled')
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /^Sign-in did not complete: /)
    assert.ok(!existsSync(join(harnessHome, 'codex-subscription', 'auth.json')))
  })
})

test('a sign-in the user has not finished answers pending, and a disconnect cancels it', async () => {
  await withFakeAgent('codex-subscription', 'device-code-pending', async (h) => {
    const harnessHome = harnessHomeOf(h)
    const shown = await startOauthLogin('codex-subscription', { harnessHome })
    const loginId = (shown as { loginId: string }).loginId
    assert.deepEqual(await awaitOauthLogin(loginId, 50), { pending: true })
    await disconnectOauth('codex-subscription', { harnessHome })
    assert.deepEqual(await awaitOauthLogin(loginId, 50), { ok: false, error: 'Login attempt expired — start again' })
  })
})

test('the device-code sign-in needs the agent’s harness home and spawns nothing without one', async () => {
  await withFakeAgent('codex-subscription', '', async (h) => {
    await assert.rejects(startOauthLogin('codex-subscription'), /harness home/)
    await assert.rejects(oauthLoginStatus('codex-subscription'), /harness home/)
    assert.deepEqual(h.requests(), [])
  })
})

test('a session without a stored login says to sign in first, and opens once the login is stored', async () => {
  await withFakeAgent('codex-subscription', '', async (h) => {
    const selection = subscriptionSelection({ cwd: h.cwd, harnessHome: harnessHomeOf(h) })
    await assert.rejects(h.client.createSession(selection), {
      message:
        'Codex (ChatGPT subscription) is not signed in: sign in to its account first, then start the session again.',
    })
    const shown = await startOauthLogin('codex-subscription', { harnessHome: selection.harnessHome })
    assert.deepEqual(await awaitOauthLogin((shown as { loginId: string }).loginId), { ok: true })
    const meta = await h.client.createSession(selection)
    assert.ok(meta.id.startsWith('fake-'))
    // The refusing process was retired: the session that opened is a fresh
    // one, which read the login at start. No session connection authenticates.
    assert.deepEqual(
      h.requests().map((request) => request.method),
      ['initialize', 'session/new', 'initialize', 'authenticate', 'elicitation/response', 'initialize', 'session/new'],
    )
    assertNoLeak(h)
  })
})

// ── steering: codex-acp's `_session/steering` contract ─────────────────────
//
// The fake plays codex-acp 1.13.1's steering (see its header): it ignores
// `idleBehavior`, and a steer that finds no live turn becomes a turn Codex
// starts and runs by itself. Every test counts what reached the agent, because
// the defect this pins is a message arriving twice.

const READER = { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } } as const

function connectionOf(selection: AgentSelection): AgentConnection {
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  const entry = store?.connections.get(connectionKey(selection)) as { connection: AgentConnection } | undefined
  assert.ok(entry, 'the session has a live connection')
  return entry.connection
}

async function steeringSession(h: Parameters<Parameters<typeof withFakeAgent>[2]>[0]) {
  const selection = codexSelection({ cwd: h.cwd })
  const meta = await h.client.createSession(selection)
  const fake = (method: string, params: Record<string, unknown> = {}) =>
    connectionOf(selection).extMethod?.(method, params)
  const sent = (method: string) => h.requests().filter((request) => request.method === method)
  const prompts = () => sent('session/prompt').map((request) => JSON.stringify(request.params.prompt))
  const said = (word: string) => h.events.filter((event) => event.kind === 'user' && event.text.includes(word))
  const turnEnds = () =>
    h.events.filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
  // A first turn, running.
  await h.client.prompt(meta.id, 'first', READER)
  await until(() => h.events.some((event) => event.kind === 'agent_message'), 'the first turn to stream')
  return { selection, id: meta.id, fake, sent, prompts, said, turnEnds }
}

// The race codex-acp answers `startedNewTurn` in: the steer reaches the live
// turn's end instead of the turn, and Codex starts a turn of its own with it.
async function steerIntoAnEndingTurn(
  h: Parameters<Parameters<typeof withFakeAgent>[2]>[0],
  s: Awaited<ReturnType<typeof steeringSession>>,
): Promise<void> {
  await s.fake('_fake/steer_mode', { mode: 'late' })
  const sending = h.client.prompt(s.id, 'steered', READER)
  await until(() => s.sent('_session/steering').length === 1, 'the steer to go out')
  await s.fake('_fake/finish')
  await sending
  await until(() => s.said('steered').length === 1, 'the steered message to show')
  // Long enough for a prompt the engine might still send to reach the log: a
  // re-delivery is exactly what the callers count.
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('the codex entry trusts the steering codex-acp advertises, and reads its idle status as the end of a turn', async () => {
  const adapter = findAdapter('codex')
  assert.equal(adapter?.advertisedSteering, undefined, 'no override: the advertised steering is used')
  const end = adapter?.harnessTurnEnd
  assert.ok(end)
  const status = (type: string) =>
    ({ sessionUpdate: 'session_info_update', _meta: { codex: { threadStatus: { type } } } }) as Parameters<
      typeof end
    >[0]
  assert.equal(end(status('idle')), 'idle')
  assert.equal(end(status('systemError')), 'error')
  assert.equal(end(status('active')), undefined)
  assert.equal(end({ sessionUpdate: 'session_info_update', title: 'x' } as Parameters<typeof end>[0]), undefined)
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    assert.equal(supportsMidTurnInput(s.selection), true, 'a Codex session takes mid-turn input')
    await s.fake('_fake/finish')
  })
})

test('Codex: a steer into a live turn is injected once, and the turn ends on its own prompt', async () => {
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    await h.client.prompt(s.id, 'steered', READER)
    await until(() => s.said('steered').length === 1, 'the injected message to show')
    assert.equal(s.sent('_session/steering').length, 1)
    assert.equal(s.sent('session/prompt').length, 1, 'no prompt of its own')
    assert.equal(s.turnEnds().length, 0, 'the turn it joined is still running')
    await s.fake('_fake/finish')
    await until(() => s.turnEnds().length === 1, 'the turn to end')
    assert.equal(h.client.hasActiveTurn(s.id), false)
    assert.equal(s.said('steered').length, 1, 'recorded once')
  })
})

test('Codex: a steer answered with a turn of its own is delivered once, and holds the session until Codex is idle', async () => {
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    await steerIntoAnEndingTurn(h, s)
    assert.equal(s.sent('session/prompt').length, 1, 'never re-sent as a prompt: Codex already has it')
    assert.equal(s.said('steered').length, 1, 'and recorded once')
    assert.deepEqual(
      s.turnEnds().map((event) => event.stopReason),
      ['end_turn'],
      'the turn it missed reported its own end',
    )
    assert.equal(h.client.hasActiveTurn(s.id), true, 'the turn Codex started counts as running')

    // Something sent meanwhile waits for that turn, as it would behind any.
    h.client.setPresence(s.id, { kind: 'online' })
    await h.client.prompt(s.id, 'later', READER)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(s.sent('session/prompt').length, 1, 'nothing is started on top of the turn Codex runs')

    await s.fake('_fake/finish')
    await until(() => s.turnEnds().length === 2, 'the turn Codex started to end')
    assert.equal(s.turnEnds()[1].stopReason, 'end_turn')
    await until(() => s.sent('session/prompt').length === 2, 'the waiting message to go out')
    assert.match(s.prompts()[1], /later/)
    await s.fake('_fake/finish')
    await until(() => s.turnEnds().length === 3, 'the last turn to end')
    assert.equal(h.client.hasActiveTurn(s.id), false, 'nothing left counted as running')

    // Three replies, three blocks: the item ids Codex stamps keep them apart.
    const replies = foldEvents(h.events).filter((message) => message.kind === 'assistant')
    assert.equal(replies.length, 3)
  })
})

test('Codex: a turn it started carries its typed failure on its turn_end', async () => {
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    await steerIntoAnEndingTurn(h, s)
    await s.fake('_fake/finish', { fail: true })
    await until(() => s.turnEnds().length === 2, 'the failed turn to end')
    assert.equal(s.turnEnds()[1].failure?.id, 'failure-2')
    assert.equal(s.turnEnds()[0].failure, undefined, 'the turn before it did not fail')
    assert.equal(h.client.hasActiveTurn(s.id), false)
  })
})

test('Codex: a turn it started ends on a systemError status too, as an error', async () => {
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    await steerIntoAnEndingTurn(h, s)
    const errors = h.events.filter((event) => event.kind === 'error').length
    await s.fake('_fake/finish', { systemError: true })
    await until(() => h.client.hasActiveTurn(s.id) === false, 'the session to be idle')
    assert.equal(h.events.filter((event) => event.kind === 'error').length, errors + 1)
    assert.equal(s.turnEnds().length, 1, 'no turn_end with a reason Codex never gave')
  })
})

test('Codex: stopping a turn it started reports it cancelled', async () => {
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    await steerIntoAnEndingTurn(h, s)
    await h.client.cancel(s.id)
    await until(() => s.turnEnds().length === 2, 'the stopped turn to end')
    assert.equal(s.turnEnds()[1].stopReason, 'cancelled')
    assert.equal(h.client.hasActiveTurn(s.id), false)
  })
})

test('Codex: a process that dies during a turn it started ends that turn, and the session moves on', async () => {
  await withFakeAgent('codex', 'steering', async (h) => {
    const s = await steeringSession(h)
    await steerIntoAnEndingTurn(h, s)
    h.client.setPresence(s.id, { kind: 'online' })
    await h.client.prompt(s.id, 'later', READER)
    assert.equal(s.sent('session/prompt').length, 1, 'held behind the turn Codex runs')

    await s.fake('_fake/exit')
    // The held message goes to the replacement process: the queue drains.
    await until(() => s.sent('session/prompt').length === 2, 'the waiting message to go out')
    assert.match(s.prompts()[1], /later/)
    assert.ok(
      h.events.some((event) => event.kind === 'error' && event.message.includes('process exited')),
      'and the turn that died is reported, not passed off as finished',
    )
    // And Stop reaches a live turn again rather than a process that is gone.
    await h.client.cancel(s.id)
    await until(() => h.client.hasActiveTurn(s.id) === false, 'the stopped turn to end')
    assert.equal(s.turnEnds().at(-1)?.stopReason, 'cancelled')
  })
})

for (const mode of ['failed', 'throw'] as const) {
  test(`Codex: a steer that ${mode === 'failed' ? 'answers failed' : 'throws'} is delivered once, as a prompt after the turn`, async () => {
    await withFakeAgent('codex', 'steering', async (h) => {
      const s = await steeringSession(h)
      await s.fake('_fake/steer_mode', { mode })
      await h.client.prompt(s.id, 'steered', READER)
      await until(() => s.sent('_session/steering').length === 1, 'the steer to go out')
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(s.sent('session/prompt').length, 1, 'not forced in on top of the running turn')
      assert.equal(s.said('steered').length, 0, 'not shown as delivered: it was not')
      assert.equal(
        h.events.some((event) => event.kind === 'error' && event.message.startsWith('steering failed')),
        mode === 'throw',
        'a steering channel that errors says so',
      )
      await s.fake('_fake/steer_mode', { mode: 'normal' })
      await s.fake('_fake/finish')
      await until(() => s.sent('session/prompt').length === 2, 'the message to go out as a prompt')
      assert.match(s.prompts()[1], /steered/)
      assert.equal(s.said('steered').length, 1, 'recorded once, when it was delivered')
      await s.fake('_fake/finish')
      await until(() => s.turnEnds().length === 2, 'both turns to end')
      assert.equal(s.sent('_session/steering').length, 1, 'tried once, delivered once')
    })
  })
}
