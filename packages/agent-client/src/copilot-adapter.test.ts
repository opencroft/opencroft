import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentClient, type PermissionContext, type PermissionHandler } from './agent-client'
import { ActionRequiredError } from './errors'
import { HARNESS_ADAPTERS, OPENAI_DEFAULT_BASE_URL } from './harness-adapters'
import { adaptersForProvider, buildSpawnConfig, findAdapter, findProvider, spawnEnvironment } from './resolve'
import type { AgentSelection, ChatEvent } from './types'

// The Copilot adapters, checked without a GitHub account or a model provider:
// the spawn contract measured against the Copilot CLI 1.0.95, and the engine
// against a fake agent that keeps that contract
// (test-fixtures/fake-copilot-agent.mjs).

const KEY = 'sk-test-DO-NOT-LEAK-0123456789abcdef'
const TOKEN = 'github_pat_TEST_DO_NOT_LEAK_0123456789abcdef'
// What an agent's environment may carry for other purposes; made up.
const INHERITED = {
  GH_TOKEN: 'gho_INHERITED_GH_TOKEN_0123456789',
  GITHUB_TOKEN: 'ghs_INHERITED_GITHUB_TOKEN_0123456789',
  COPILOT_PROVIDER_BASE_URL: 'https://inherited.example.test/v1',
  COPILOT_ALLOW_ALL: 'true',
}

const ZAI_OPENAI_ENDPOINT = findProvider('zai')?.endpoints.openai

function byokSelection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return { providerId: 'zai', adapterId: 'copilot', model: 'glm-5.3', apiKey: KEY, cwd: '/work/agent', ...overrides }
}

function subscriptionSelection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return {
    providerId: 'github-copilot',
    adapterId: 'copilot-subscription',
    model: 'auto',
    apiKey: TOKEN,
    cwd: '/work/agent',
    ...overrides,
  }
}

const copilotNames = (env: Record<string, string | undefined>) =>
  Object.keys(env)
    .filter((name) => /^(COPILOT_|GH_|GITHUB_)/.test(name))
    .sort()

// ── the adapter entries ─────────────────────────────────────────────────────

test('copilot spawns the pinned CLI in ACP mode with auto-update off', () => {
  for (const selection of [byokSelection(), subscriptionSelection()]) {
    const config = buildSpawnConfig(selection)
    assert.equal(config.command, 'npx')
    assert.deepEqual(config.args, ['-y', '@github/copilot@1.0.95', '--acp', '--no-auto-update'])
  }
})

test("BYOK hands Copilot the profile's endpoint, key and model, in its own home", () => {
  const config = buildSpawnConfig(byokSelection())
  assert.deepEqual(config.env, {
    COPILOT_HOME: '/work/agent/.harness-home/copilot',
    GH_CONFIG_DIR: '/work/agent/.harness-home/copilot/gh',
    COPILOT_PROVIDER_API_KEY: KEY,
    COPILOT_MODEL: 'glm-5.3',
    COPILOT_PROVIDER_BASE_URL: ZAI_OPENAI_ENDPOINT,
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_WIRE_API: 'completions',
  })
  assert.deepEqual(config.ensureDirs, ['/work/agent/.harness-home/copilot'])
  assert.deepEqual(config.unsetEnv, ['COPILOT_*', 'GH_*', 'GITHUB_*'])
})

test('BYOK uses the Responses API where the provider or the profile says the endpoint serves it', () => {
  const openai = buildSpawnConfig(byokSelection({ providerId: 'openai', model: 'gpt-5' })).env
  assert.equal(openai.COPILOT_PROVIDER_BASE_URL, OPENAI_DEFAULT_BASE_URL)
  assert.equal(openai.COPILOT_PROVIDER_WIRE_API, 'responses')
  const custom = (responsesApi?: boolean) =>
    buildSpawnConfig(
      byokSelection({ providerId: 'openai-compatible', baseUrl: 'https://llm.example/v1', responsesApi }),
    ).env
  assert.equal(custom().COPILOT_PROVIDER_BASE_URL, 'https://llm.example/v1')
  assert.equal(custom().COPILOT_PROVIDER_WIRE_API, 'completions')
  assert.equal(custom(true).COPILOT_PROVIDER_WIRE_API, 'responses')
})

test('the subscription variant hands Copilot only the token and the model, in a home of its own', () => {
  const config = buildSpawnConfig(subscriptionSelection({ harnessHome: '/data/harness-home/agent-a/' }))
  assert.deepEqual(config.env, {
    COPILOT_HOME: '/data/harness-home/agent-a/copilot-subscription',
    GH_CONFIG_DIR: '/data/harness-home/agent-a/copilot-subscription/gh',
    COPILOT_GITHUB_TOKEN: TOKEN,
    COPILOT_MODEL: 'auto',
  })
})

test('BYOK is offered on OpenAI-style providers, the subscription on GitHub Copilot alone', () => {
  const ids = (providerId: string) => adaptersForProvider(providerId).map((adapter) => adapter.id)
  for (const provider of ['zai', 'openai', 'openai-compatible', 'openrouter', 'dashscope']) {
    assert.ok(ids(provider).includes('copilot'), provider)
    assert.ok(!ids(provider).includes('copilot-subscription'), provider)
  }
  assert.ok(!ids('anthropic').includes('copilot'))
  assert.ok(!ids('google').includes('copilot'))
  assert.ok(ids('github-copilot').includes('copilot-subscription'))
  assert.ok(!ids('github-copilot').includes('copilot'))
})

// Each is the profile's to fix, so each says so by class.
function actionRequired(message: RegExp) {
  return (error: unknown) => error instanceof ActionRequiredError && message.test(error.message)
}

test('a profile without what its variant needs is refused with what is missing', () => {
  const check = (selection: AgentSelection) => () =>
    findAdapter(selection.adapterId)?.checkSelection?.(findProvider(selection.providerId), selection)
  assert.doesNotThrow(check(byokSelection()))
  assert.doesNotThrow(check(subscriptionSelection()))
  assert.throws(check(byokSelection({ model: '' })), actionRequired(/needs a model/))
  assert.throws(check(byokSelection({ apiKey: '' })), actionRequired(/needs an API key/))
  assert.throws(check(subscriptionSelection({ apiKey: '' })), actionRequired(/needs a GitHub token/))
  assert.throws(
    check(subscriptionSelection({ apiKey: 'ghp_classic0123456789' })),
    actionRequired(/does not accept classic personal access tokens/),
  )
})

// ── the scrubbed environment ────────────────────────────────────────────────

test('a host spawn inherits no Copilot or GitHub variable the spawn does not set itself', () => {
  const config = buildSpawnConfig(subscriptionSelection())
  const env = spawnEnvironment({ PATH: '/usr/bin', HOME: '/home/agent', ...INHERITED }, config)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/agent')
  assert.deepEqual(copilotNames(env), ['COPILOT_GITHUB_TOKEN', 'COPILOT_HOME', 'COPILOT_MODEL', 'GH_CONFIG_DIR'])
  assert.equal(env.COPILOT_GITHUB_TOKEN, TOKEN)
})

test('an adapter without scrubEnv inherits the whole host environment', () => {
  const config = buildSpawnConfig(byokSelection({ adapterId: 'claude', providerId: 'anthropic' }))
  assert.equal(config.unsetEnv, undefined)
  assert.equal(spawnEnvironment({ ...INHERITED }, config).GH_TOKEN, INHERITED.GH_TOKEN)
})

test('a container spawn unsets them inside the container and keeps what it forwards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-container-'))
  try {
    const cwd = join(dir, 'work')
    const config = buildSpawnConfig(subscriptionSelection({ containerName: 'agents', cwd }))
    assert.equal(config.command, 'docker')
    for (const name of Object.keys(config.env)) {
      assert.ok(config.args.includes(name), `${name} forwarded by name`)
    }
    // Runs the script docker would run in the container, with `env` as the
    // harness: the container's own environment carries the inherited values,
    // and `docker exec -e` has added the forwarded ones.
    const shIndex = config.args.indexOf('sh')
    const script = config.args[shIndex + 2]
    const result = spawnSync('sh', ['-c', script, 'env'], {
      env: { PATH: process.env.PATH, ...INHERITED, GH_ENTERPRISE_TOKEN: 'x', ...config.env },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const seen = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    assert.deepEqual(copilotNames(seen), ['COPILOT_GITHUB_TOKEN', 'COPILOT_HOME', 'COPILOT_MODEL', 'GH_CONFIG_DIR'])
    assert.equal(seen.COPILOT_GITHUB_TOKEN, TOKEN)
    assert.ok(existsSync(join(cwd, '.harness-home', 'copilot-subscription')), 'the home is made in the workdir')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the engine against a fake Copilot ───────────────────────────────────────

const FAKE_AGENT = fileURLToPath(new URL('./test-fixtures/fake-copilot-agent.mjs', import.meta.url))

interface LoggedRequest {
  method: string
  params: Record<string, unknown>
  env?: Record<string, string>
  // The fake's own records of a tool call: how it was answered, and whether
  // it ran.
  outcome?: { outcome: string; optionId?: string }
  ran?: boolean
}

// Points both Copilot entries at the fake agent for one test, with the
// inherited variables in the host's environment, and collects the agent's
// request log, every emitted event and everything printed to console.error.
// `permissionHandler` is the host's, as given to the engine.
async function withFakeCopilot(
  run: (h: {
    client: ReturnType<typeof createAgentClient>
    cwd: string
    requests: () => LoggedRequest[]
    events: ChatEvent[]
    printed: string[]
  }) => Promise<void>,
  permissionHandler?: PermissionHandler,
): Promise<void> {
  const adapters = HARNESS_ADAPTERS.filter((entry) => entry.id.startsWith('copilot'))
  assert.equal(adapters.length, 2)
  const saved = adapters.map((adapter) => ({ adapter, command: adapter.command, args: adapter.args }))
  const dir = mkdtempSync(join(tmpdir(), 'copilot-base-'))
  const logFile = join(dir, 'requests.jsonl')
  const cwd = join(dir, 'work')
  mkdirSync(cwd)
  const savedEnv = Object.fromEntries(
    [...Object.keys(INHERITED), 'FAKE_AGENT_LOG'].map((name) => [name, process.env[name]]),
  )
  Object.assign(process.env, INHERITED, { FAKE_AGENT_LOG: logFile })
  for (const adapter of adapters) {
    adapter.command = process.execPath
    adapter.args = [FAKE_AGENT]
  }
  const printed: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    printed.push(args.map(String).join(' '))
  }
  const events: ChatEvent[] = []
  const client = createAgentClient({
    permissionHandler,
    onEvent: (_sessionId, event) => events.push(event),
    loadMcpServers: async () => [
      { name: 'remote', transport: 'http', url: 'http://127.0.0.1:9/mcp' },
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
    for (const { adapter, command, args } of saved) {
      adapter.command = command
      adapter.args = args
    }
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function assertNoLeak(h: { events: ChatEvent[]; printed: string[] }, secret: string, error?: unknown): void {
  assert.ok(!JSON.stringify(h.events).includes(secret), 'no emitted event carries the credential')
  assert.ok(!h.printed.join('\n').includes(secret), 'nothing printed carries the credential')
  if (error !== undefined) {
    assert.ok(!String((error as Error).message).includes(secret), 'the thrown error does not carry the credential')
  }
}

test("a BYOK session opens on the profile's provider alone, with every MCP server the agent has", async () => {
  await withFakeCopilot(async (h) => {
    const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
    assert.ok(meta.id.startsWith('fake-'))
    const requests = h.requests()
    assert.deepEqual(
      requests.map((request) => request.method),
      ['initialize', 'session/new'],
      'Copilot needs no authenticate',
    )
    const [init, created] = requests
    assert.deepEqual(copilotNames(init.env ?? {}), [
      'COPILOT_HOME',
      'COPILOT_MODEL',
      'COPILOT_PROVIDER_API_KEY',
      'COPILOT_PROVIDER_BASE_URL',
      'COPILOT_PROVIDER_TYPE',
      'COPILOT_PROVIDER_WIRE_API',
      'GH_CONFIG_DIR',
    ])
    assert.equal(init.env?.COPILOT_PROVIDER_BASE_URL, ZAI_OPENAI_ENDPOINT, 'not the inherited one')
    assert.ok(existsSync(join(h.cwd, '.harness-home', 'copilot')))
    const servers = (created.params.mcpServers as { name: string }[]).map((server) => server.name)
    for (const name of ['remote', 'legacy-sse', 'files']) {
      assert.ok(servers.includes(name), `${name} reaches Copilot, which accepts every transport`)
    }
    assert.ok(!h.events.some((event) => event.kind === 'error'), 'nothing is reported dropped')
    assertNoLeak(h, KEY)
  })
})

test('a subscription session signs in with the profile token, never an inherited one', async () => {
  await withFakeCopilot(async (h) => {
    await h.client.createSession(subscriptionSelection({ cwd: h.cwd }))
    const [init] = h.requests()
    assert.deepEqual(copilotNames(init.env ?? {}), [
      'COPILOT_GITHUB_TOKEN',
      'COPILOT_HOME',
      'COPILOT_MODEL',
      'GH_CONFIG_DIR',
    ])
    assert.equal(init.env?.COPILOT_GITHUB_TOKEN, TOKEN)
    assertNoLeak(h, TOKEN)
  })
})

// ── slash commands ──────────────────────────────────────────────────────────

// What the composer offers of the 33 the fake advertises, as 1.0.95 does.
const KEPT_COMMANDS = [
  'autopilot',
  'compact',
  'blame',
  'chronicle',
  'context',
  'env',
  'fleet',
  'init',
  'list-dirs',
  'plan',
  'rename',
  'research',
  'review',
  'security-review',
  'skills',
  'subconscious',
  'usage',
]

test('both variants list no command that reaches past the session or changes what the command bar owns', async () => {
  await withFakeCopilot(async (h) => {
    for (const selection of [byokSelection({ cwd: h.cwd }), subscriptionSelection({ cwd: h.cwd })]) {
      h.events.length = 0
      await h.client.createSession(selection)
      const listed = await until(() => {
        const snapshot = h.events.find((event) => event.kind === 'available_commands')
        return snapshot?.kind === 'available_commands' ? snapshot.commands : undefined
      }, `${selection.adapterId}'s commands`)
      assert.deepEqual(
        listed.map((command) => command.name),
        KEPT_COMMANDS,
        selection.adapterId,
      )
    }
  })
})

test('a profile without what Copilot needs is refused before anything is spawned', async () => {
  await withFakeCopilot(async (h) => {
    for (const selection of [
      subscriptionSelection({ cwd: h.cwd, apiKey: '' }),
      byokSelection({ cwd: h.cwd, model: '' }),
    ]) {
      const error = await h.client.createSession(selection).then(
        () => assert.fail('createSession must fail'),
        (caught: unknown) => caught,
      )
      assert.ok(error instanceof ActionRequiredError, String(error))
    }
    assert.deepEqual(h.requests(), [], 'no process was started')
  })
})

// ── modes and permission requests ───────────────────────────────────────────

const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#'
const CALL_APP = 'call app_call on the graph'

// The fake answers over a real pipe, so each step waits for the state it
// expects rather than for a fixed delay.
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read()
    if (value !== undefined) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

function card(events: ChatEvent[]) {
  const asked = events.find((event) => event.kind === 'permission_request')
  return asked?.kind === 'permission_request' ? asked : undefined
}

function toolRun(requests: LoggedRequest[]): boolean | undefined {
  return requests.find((request) => request.method === 'tool')?.ran
}

function allowAll(client: ReturnType<typeof createAgentClient>, sessionId: string): unknown {
  return client.sessionConfigOptions(sessionId)?.find((option) => option.id === 'allow_all')?.currentValue
}

test("Copilot's ask about a host tool reaches the host by that tool's name, and Allow on its card runs it", async () => {
  const seen: PermissionContext[] = []
  await withFakeCopilot(
    async (h) => {
      const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
      void h.client.prompt(meta.id, CALL_APP, { queue: 'push', origin: { kind: 'system' } })
      const asked = await until(() => card(h.events), 'the permission card')
      assert.deepEqual(
        asked.options.map((option) => [option.id, option.label]),
        [
          ['allow_once', 'Allow once'],
          ['allow_always', 'Always allow'],
          ['reject_once', 'Deny'],
        ],
      )
      // The request names only `app_call`; the call it announced, `local-app_call`,
      // says it is on the host's own server.
      assert.equal(seen[0]?.localToolName, 'app_call')
      assert.equal(seen[0]?.toolKind, 'other')
      h.client.resolvePermission(asked.requestId, 'allow_once')
      assert.equal(await until(() => toolRun(h.requests()), 'the tool call'), true)
    },
    (context) => {
      seen.push(context)
      return 'prompt'
    },
  )
})

test("Deny on Copilot's card does not run the call", async () => {
  await withFakeCopilot(
    async (h) => {
      const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
      void h.client.prompt(meta.id, CALL_APP, { queue: 'push', origin: { kind: 'system' } })
      const asked = await until(() => card(h.events), 'the permission card')
      h.client.resolvePermission(asked.requestId, 'reject_once')
      assert.equal(await until(() => toolRun(h.requests()), 'the tool call'), false)
      const answered = h.requests().find((request) => request.method === 'permission answered')
      assert.deepEqual(answered?.outcome, { outcome: 'selected', optionId: 'reject_once' })
    },
    () => 'prompt',
  )
})

test('a card still open when the turn is stopped is answered cancelled, and the call does not run', async () => {
  await withFakeCopilot(
    async (h) => {
      const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
      void h.client.prompt(meta.id, CALL_APP, { queue: 'push', origin: { kind: 'system' } })
      const asked = await until(() => card(h.events), 'the permission card')
      await h.client.cancel(meta.id)
      const answered = await until(
        () => h.requests().find((request) => request.method === 'permission answered'),
        'the answer',
      )
      assert.deepEqual(answered.outcome, { outcome: 'cancelled' })
      assert.ok(
        h.events.some((event) => event.kind === 'permission_resolved' && event.requestId === asked.requestId),
        'the card closes',
      )
      assert.equal(toolRun(h.requests()), undefined)
    },
    () => 'prompt',
  )
})

test("the command bar's mode reaches Copilot, and Copilot's own allow_all follows autopilot", async () => {
  await withFakeCopilot(async (h) => {
    const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
    await h.client.setConfigOption(meta.id, 'mode', `${MODE_URL}plan`)
    assert.equal(h.client.sessionModes(meta.id)?.current, `${MODE_URL}plan`)
    await h.client.setConfigOption(meta.id, 'mode', `${MODE_URL}autopilot`)
    assert.equal(allowAll(h.client, meta.id), 'on')
    await h.client.setConfigOption(meta.id, 'mode', `${MODE_URL}agent`)
    assert.equal(h.client.sessionModes(meta.id)?.current, `${MODE_URL}agent`)
    assert.equal(allowAll(h.client, meta.id), 'off')
  })
})

test("a mode Copilot switches to on its own, reported with no option update, reaches the command bar's mode option", async () => {
  await withFakeCopilot(async (h) => {
    const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
    // With allow_all already on, entering autopilot changes no option, so
    // Copilot reports the mode alone.
    await h.client.setConfigOption(meta.id, 'allow_all', 'on')
    const shownMode = () => {
      const shown = [...h.events].reverse().find((event) => event.kind === 'config_options')
      return shown?.kind === 'config_options'
        ? shown.options.find((option) => option.id === 'mode')?.currentValue
        : undefined
    }
    void h.client.prompt(meta.id, '/autopilot on', { queue: 'push', origin: { kind: 'system' } })
    await until(() => (shownMode() === `${MODE_URL}autopilot` ? true : undefined), 'the bar on autopilot')
    assert.equal(h.client.sessionModes(meta.id)?.current, `${MODE_URL}autopilot`)
    assert.equal(
      h.client.sessionConfigOptions(meta.id)?.find((option) => option.id === 'mode')?.currentValue,
      `${MODE_URL}autopilot`,
    )
    void h.client.prompt(meta.id, '/autopilot off', { queue: 'push', origin: { kind: 'system' } })
    await until(() => (shownMode() === `${MODE_URL}agent` ? true : undefined), 'the bar back on agent')
  })
})

test('`/autopilot on` shows the allow_all Copilot reports after the turn, and `/autopilot off` shows it off', async () => {
  await withFakeCopilot(async (h) => {
    const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
    const shownAllowAll = () => {
      const shown = [...h.events].reverse().find((event) => event.kind === 'config_options')
      return shown?.kind === 'config_options'
        ? shown.options.find((option) => option.id === 'allow_all')?.currentValue
        : undefined
    }
    const reads = (value: string) => (allowAll(h.client, meta.id) === value ? true : undefined)
    assert.equal(allowAll(h.client, meta.id), 'off')
    void h.client.prompt(meta.id, '/autopilot on', { queue: 'push', origin: { kind: 'system' } })
    await until(() => reads('on'), 'allow_all on')
    assert.equal(h.client.sessionModes(meta.id)?.current, `${MODE_URL}autopilot`)
    assert.equal(shownAllowAll(), 'on')
    void h.client.prompt(meta.id, '/autopilot off', { queue: 'push', origin: { kind: 'system' } })
    await until(() => reads('off'), 'allow_all off')
    assert.equal(h.client.sessionModes(meta.id)?.current, `${MODE_URL}agent`)
    assert.equal(shownAllowAll(), 'off')
  })
})

test('allow_all switched off inside autopilot stays off through a repeated `/autopilot on`, and Copilot asks again', async () => {
  await withFakeCopilot(
    async (h) => {
      const meta = await h.client.createSession(byokSelection({ cwd: h.cwd }))
      void h.client.prompt(meta.id, '/autopilot on', { queue: 'push', origin: { kind: 'system' } })
      await until(() => (allowAll(h.client, meta.id) === 'on' ? true : undefined), 'allow_all on')
      await h.client.setConfigOption(meta.id, 'allow_all', 'off')
      assert.equal(allowAll(h.client, meta.id), 'off')
      void h.client.prompt(meta.id, '/autopilot on', { queue: 'push', origin: { kind: 'system' } })
      await until(
        () =>
          h.events.some((event) => event.kind === 'agent_message' && event.text === 'Already in autopilot mode.')
            ? true
            : undefined,
        'the answer to the repeated command',
      )
      void h.client.prompt(meta.id, CALL_APP, { queue: 'push', origin: { kind: 'system' } })
      const asked = await until(() => card(h.events), 'the permission card')
      assert.equal(h.client.sessionModes(meta.id)?.current, `${MODE_URL}autopilot`)
      assert.equal(allowAll(h.client, meta.id), 'off')
      h.client.resolvePermission(asked.requestId, 'allow_once')
      assert.equal(await until(() => toolRun(h.requests()), 'the tool call'), true)
    },
    () => 'prompt',
  )
})

test("a session opens in the profile's mode, written in Copilot's spelling or in ours", async () => {
  await withFakeCopilot(async (h) => {
    const setModes = () =>
      h
        .requests()
        .filter((request) => request.method === 'session/set_mode')
        .map((request) => request.params.modeId)
    const ours = await h.client.createSession(byokSelection({ cwd: h.cwd }), 'plan')
    assert.equal(h.client.sessionModes(ours.id)?.current, `${MODE_URL}plan`)
    const wire = await h.client.createSession(byokSelection({ cwd: h.cwd }), `${MODE_URL}plan`)
    assert.equal(h.client.sessionModes(wire.id)?.current, `${MODE_URL}plan`)
    // Bypass is not a Copilot mode, and Claude Code's `default` means nothing
    // to it: both open as Copilot does, in agent.
    const bypass = await h.client.createSession(byokSelection({ cwd: h.cwd }), 'bypassPermissions')
    const claude = await h.client.createSession(byokSelection({ cwd: h.cwd }), 'default')
    for (const session of [bypass, claude]) {
      assert.equal(h.client.sessionModes(session.id)?.current, `${MODE_URL}agent`)
    }
    assert.deepEqual(setModes(), [`${MODE_URL}plan`, `${MODE_URL}plan`])
  })
})
