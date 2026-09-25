// codex-acp against this engine, from payloads copied out of codex-acp 1.13.1's
// source (each fixture names the file it came from). Observed live against the
// real 1.13.1: after session/new, configOptions are `mode`,
// `collaboration_mode` and `model`, the modes are `read-only`, `agent` and
// `agent-full-access`, and the current mode is `agent`; `reasoning_effort` and
// `fast-mode` appear only for a catalog model that lists them.
//
// What each part pins:
// - the config selectors find Codex's effort and fast options by category,
//   where their ids (`reasoning_effort`, `fast-mode`) match nothing we key on;
// - the modes classify, by `_meta.kind` first and by id otherwise;
// - a mode change made through either door is reflected in the other, because
//   codex-acp reports neither (src/CodexAcpServer.ts setSessionMode returns {});
// - a rejection is answered with Codex's own `decline`, not ACP `cancelled`,
//   which codex-acp turns into `cancel` and so aborts the turn.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import { buildClient, connectionKey, createAgentClient, pickRejectOption } from './agent-client'
import {
  FAST_MODE_SELECTOR,
  findConfigOption,
  findSelectOption,
  MODE_SELECTOR,
  MODEL_SELECTOR,
  THOUGHT_LEVEL_SELECTOR,
} from './config-selectors'
import type { AgentConnection } from './connection'
import { canonicalModeOf, classifyModes, modeIdForCanonical, mostSupervisedModeId } from './session-modes'
import type { AgentSelection, ChatEvent, SessionMode } from './types'

// src/AgentMode.ts, AgentMode.toSessionModeState() — every preset, in its own
// order, each carrying `_meta.kind`.
const CODEX_MODES: SessionMode[] = [
  {
    id: 'read-only',
    name: 'Ask for approval',
    description: 'Always ask to edit external files and use the internet',
    _meta: { kind: 'standard' },
  },
  {
    id: 'agent',
    name: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe',
    _meta: { kind: 'auto_review' },
  },
  {
    id: 'agent-full-access',
    name: 'Full access',
    description: 'Unrestricted access to the internet and any file on your computer',
    _meta: { kind: 'full_access' },
  },
]

// src/AgentMode.ts, AgentMode.toConfigOption().
function codexModeOption(currentValue: string): SessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    description: 'Approval and sandboxing preset for the session',
    category: 'mode',
    type: 'select',
    currentValue,
    options: CODEX_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
      _meta: mode._meta,
    })),
  }
}

// src/CodexAcpServer.ts createSessionConfigOptions(), for a catalog model that
// lists reasoning efforts and the fast tier: mode, then
// src/CollaborationModeConfig.ts, src/ModelConfigOption.ts (model, then
// reasoning effort), then src/FastModeConfig.ts in its select shape.
function codexConfigOptions(mode = 'agent'): SessionConfigOption[] {
  return [
    codexModeOption(mode),
    {
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      description: 'How Codex collaborates for subsequent turns',
      category: 'collaboration_mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan', description: 'Plan before making changes' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      description: 'Model Codex uses for the session',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5.1-codex',
      options: [{ value: 'gpt-5.1-codex', name: '5.1 Codex', description: null }],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      description: 'How much reasoning effort the model should use',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: ['low', 'medium', 'high'].map((effort) => ({
        value: effort,
        name: effort[0].toUpperCase() + effort.slice(1),
        description: null,
      })),
    },
    {
      id: 'fast-mode',
      name: 'Fast mode',
      description: '1.5x speed, increased usage',
      category: 'model_config',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off', description: 'Default speed, normal usage' },
        { value: 'on', name: 'On', description: '1.5x speed, increased usage' },
      ],
    },
  ]
}

// ── config selectors ────────────────────────────────────────────────────────

test("Codex's options are found by category where their ids match nothing we key on", () => {
  const options = codexConfigOptions()
  assert.equal(findSelectOption(options, THOUGHT_LEVEL_SELECTOR)?.id, 'reasoning_effort')
  assert.equal(findConfigOption(options, FAST_MODE_SELECTOR)?.id, 'fast-mode')
  assert.equal(findSelectOption(options, MODE_SELECTOR)?.id, 'mode')
  assert.equal(findSelectOption(options, MODEL_SELECTOR)?.id, 'model')
})

test('fast mode is found in its native boolean shape too', () => {
  // src/FastModeConfig.ts createFastModeConfigOption(_, true): the shape sent
  // to a client that advertises boolean config options.
  const boolean: SessionConfigOption = {
    id: 'fast-mode',
    name: 'Fast mode',
    description: '1.5x speed, increased usage',
    category: 'model_config',
    type: 'boolean',
    currentValue: true,
  }
  assert.equal(findConfigOption([boolean], FAST_MODE_SELECTOR), boolean)
})

test('model_config alone is not fast mode: another per-model setting is left alone', () => {
  const other: SessionConfigOption = {
    id: 'verbosity',
    name: 'Verbosity',
    category: 'model_config',
    type: 'select',
    currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }],
  }
  assert.equal(findConfigOption([other], FAST_MODE_SELECTOR), undefined)
})

test('collaboration_mode is not taken for the permission mode or anything else we key on', () => {
  const collaboration = codexConfigOptions().filter((option) => option.id === 'collaboration_mode')
  for (const selector of [MODE_SELECTOR, MODEL_SELECTOR, THOUGHT_LEVEL_SELECTOR, FAST_MODE_SELECTOR]) {
    assert.equal(findConfigOption(collaboration, selector), undefined, selector.id)
  }
})

test('an agent that sends no category is still found by the conventional id', () => {
  const uncategorized: SessionConfigOption[] = [
    { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
    { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false },
  ]
  assert.equal(findSelectOption(uncategorized, THOUGHT_LEVEL_SELECTOR)?.id, 'effort')
  assert.equal(findConfigOption(uncategorized, FAST_MODE_SELECTOR)?.id, 'fast')
})

// ── modes ───────────────────────────────────────────────────────────────────

test('every Codex preset is classified', () => {
  assert.deepEqual(
    classifyModes('codex', CODEX_MODES).map((mode) => mode.canonical?.id),
    ['accept-edits', 'auto', 'bypass'],
  )
})

test('a Codex mode is classified by its stated kind even when its id is one we have never seen', () => {
  assert.equal(canonicalModeOf('codex', { id: 'renamed-full', _meta: { kind: 'full_access' } }), 'bypass')
  assert.equal(canonicalModeOf('codex', { id: 'renamed-ask', _meta: { kind: 'standard' } }), 'accept-edits')
})

test('a Codex mode with no kind still classifies by its id', () => {
  assert.equal(canonicalModeOf('codex', { id: 'agent-full-access' }), 'bypass')
  assert.equal(canonicalModeOf('codex', { id: 'agent' }), 'auto')
  assert.equal(canonicalModeOf('codex', { id: 'read-only' }), 'accept-edits')
})

test("Codex's words stay Codex's: another agent's `agent` or `standard` is unrecognised", () => {
  assert.equal(canonicalModeOf('claude', { id: 'agent' }), undefined)
  assert.equal(canonicalModeOf('some-other-agent', { id: 'read-only', _meta: { kind: 'standard' } }), undefined)
  assert.equal(canonicalModeOf('some-other-agent', { id: 'x', _meta: { kind: 'full_access' } }), undefined)
})

test("YOLO's bypass lookup finds Codex's full-access preset", () => {
  assert.equal(modeIdForCanonical('codex', CODEX_MODES, 'bypass'), 'agent-full-access')
})

test('the most supervised Codex preset is Ask for approval, since Codex has no Manual Edits', () => {
  assert.equal(modeIdForCanonical('codex', CODEX_MODES, 'manual-edits'), undefined)
  assert.equal(mostSupervisedModeId('codex', CODEX_MODES), 'read-only')
})

test('a session offering nothing but bypass has no supervised mode to fall back to', () => {
  assert.equal(mostSupervisedModeId('codex', CODEX_MODES.slice(2)), undefined)
})

// ── the engine against a seeded Codex connection ────────────────────────────

let counter = 0

// The seam agent-client.test.ts uses: a mock connection registered under the
// selection's spawn key, so createSession reuses it rather than spawning. This
// one answers like codex-acp: set_mode with `{}` and nothing pushed, set config
// option with the whole recomputed list.
async function codexSession() {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    // A no-tools adapter keeps the built-in MCP server down; nothing here reads
    // the adapter, the engine's mode bookkeeping is adapter-blind.
    adapterId: 'openclaw',
    model: 'gpt-5.1-codex',
    apiKey: '',
    cwd: `/tmp/codex-contract-test-${counter}`,
  }
  let current = 'agent'
  const connection = {
    newSession: async () => ({
      sessionId: `codex-session-${counter}`,
      modes: { availableModes: CODEX_MODES, currentModeId: current },
      configOptions: codexConfigOptions(current),
    }),
    setSessionMode: async (params: { modeId: string }) => {
      current = params.modeId
      return {}
    },
    setSessionConfigOption: async (params: { configId: string; value: unknown }) => {
      if (params.configId === 'mode') {
        current = String(params.value)
      }
      return { configOptions: codexConfigOptions(current) }
    },
    cancel: async () => {},
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient({})
  const meta = await client.createSession(selection)
  const events: ChatEvent[] = []
  client.subscribe(meta.id, (event) => events.push(event))
  return { client, sessionId: meta.id, events }
}

function dialValue(events: ChatEvent[]): unknown {
  const last = events.filter((event) => event.kind === 'config_options').at(-1)
  assert.ok(last && last.kind === 'config_options')
  return last.options.find((option) => option.id === 'mode')?.currentValue
}

test('modes keep their _meta through session/new, so the engine can classify them', async () => {
  const h = await codexSession()
  assert.deepEqual(h.client.sessionModes(h.sessionId)?.available, CODEX_MODES)
  await h.client.deleteSession(h.sessionId)
})

test('setMode moves the mode dial too, since codex-acp reports no config change', async () => {
  const h = await codexSession()
  await h.client.setMode(h.sessionId, 'agent-full-access')
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'agent-full-access')
  assert.equal(dialValue(h.events), 'agent-full-access')
  assert.ok(h.events.some((event) => event.kind === 'mode_changed' && event.current === 'agent-full-access'))
  await h.client.deleteSession(h.sessionId)
})

test('setting the mode config option moves the session mode too', async () => {
  const h = await codexSession()
  await h.client.setConfigOption(h.sessionId, 'mode', 'read-only')
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'read-only')
  assert.ok(h.events.some((event) => event.kind === 'mode_changed' && event.current === 'read-only'))
  await h.client.deleteSession(h.sessionId)
})

test('setting another option does not touch the session mode', async () => {
  const h = await codexSession()
  const before = h.events.length
  await h.client.setConfigOption(h.sessionId, 'collaboration_mode', 'plan')
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'agent')
  assert.ok(!h.events.slice(before).some((event) => event.kind === 'mode_changed'))
  await h.client.deleteSession(h.sessionId)
})

// ── rejections ──────────────────────────────────────────────────────────────

// src/permissions/options.ts commandDecisionOptions(), for a command whose
// available decisions are accept, acceptForSession, decline and cancel — both
// rejections are `reject_once`, `decline` continues the turn and `cancel`
// aborts it (docs/permission-extension.md).
const CODEX_COMMAND_OPTIONS = [
  { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' as const },
  {
    optionId: 'allow_for_session',
    name: "Yes, and don't ask again for this command in this session",
    kind: 'allow_always' as const,
  },
  { optionId: 'decline', name: 'No, continue without running it', kind: 'reject_once' as const },
  { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' as const },
]

// src/permissions/options.ts fileChangeDecisionOptions(): no `decline` here.
const CODEX_FILE_CHANGE_OPTIONS = [
  { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' as const },
  { optionId: 'allow_for_session', name: "Yes, and don't ask again for these files", kind: 'allow_always' as const },
  { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' as const },
]

test("a rejection picks Codex's decline over its cancel, in either order", () => {
  assert.equal(pickRejectOption(CODEX_COMMAND_OPTIONS), 'decline')
  assert.equal(pickRejectOption([...CODEX_COMMAND_OPTIONS].reverse()), 'decline')
})

test('a request without decline gets its own one-time reject, never a persistent one', () => {
  assert.equal(pickRejectOption(CODEX_FILE_CHANGE_OPTIONS), 'cancel')
  assert.equal(
    pickRejectOption([
      { optionId: 'block-host', name: 'No, and block this host in the future', kind: 'reject_always' },
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    ]),
    undefined,
  )
})

async function askAndReject(options: typeof CODEX_COMMAND_OPTIONS) {
  const h = await codexSession()
  const client = buildClient(() => h.sessionId, 'local')
  const response = client.requestPermission({
    sessionId: h.sessionId,
    toolCall: { toolCallId: 'call-1', title: 'Run a command' },
    options,
  })
  const asked = h.events.find((event) => event.kind === 'permission_request')
  assert.ok(asked && asked.kind === 'permission_request')
  h.client.resolvePermission(asked.requestId)
  const resolved = h.events.find((event) => event.kind === 'permission_resolved')
  await h.client.deleteSession(h.sessionId)
  return { response: await response, resolved }
}

test('a plain rejection of a Codex command is answered with decline, so the turn continues', async () => {
  const { response, resolved } = await askAndReject(CODEX_COMMAND_OPTIONS)
  assert.deepEqual(response, { outcome: { outcome: 'selected', optionId: 'decline' } })
  assert.ok(resolved && resolved.kind === 'permission_resolved')
  assert.equal(resolved.optionId, 'decline', 'the transcript records what the agent was actually told')
})

test('a request offering no reject option is still answered as cancelled', async () => {
  const { response } = await askAndReject([
    { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' as const },
  ] as typeof CODEX_COMMAND_OPTIONS)
  assert.deepEqual(response, { outcome: { outcome: 'cancelled' } })
})

test("a host's deny is answered with the request's own reject too", async () => {
  const h = await codexSession()
  const client = buildClient(
    () => h.sessionId,
    'local',
    async () => 'deny' as const,
  )
  const response = await client.requestPermission({
    sessionId: h.sessionId,
    toolCall: { toolCallId: 'call-1', title: 'Run a command' },
    options: CODEX_COMMAND_OPTIONS,
  })
  assert.deepEqual(response, { outcome: { outcome: 'selected', optionId: 'decline' } })
  await h.client.deleteSession(h.sessionId)
})
