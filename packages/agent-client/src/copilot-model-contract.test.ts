import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk'

import { connectionKey, createAgentClient } from './agent-client'
import { findSelectOption, MODEL_SELECTOR, THOUGHT_LEVEL_SELECTOR } from './config-selectors'
import type { AgentConnection } from './connection'
import { canonicalEffortId } from './session-effort'
import type { AgentSelection, ChatEvent } from './types'

// ── Copilot CLI 1.0.95 wire contract: the model picker ─────────────────────
//
// A subscription session advertises its model as a `model` option (category
// `model`, "Auto" first, then the account's catalog) beside a
// `reasoning_effort` option (category `thought_level`), and setting the model
// option moves the session's next turn to that model. A BYOK session
// advertises neither: its model is the profile's, carried by COPILOT_MODEL.
// The picker and the engine both find these options by category through
// config-selectors, so these tests pin the recorded shapes against those
// selectors rather than against one UI.
//
// Recorded from the real `@github/copilot@1.0.95 --acp`: the BYOK shape against
// a scripted OpenAI-compatible endpoint, the subscription shape against a
// local stand-in for GitHub's token and model-catalog endpoints. Model ids and
// names are neutral ones; everything else is as recorded.

const MODE_OPTION = {
  type: 'select',
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  description: 'Controls how Copilot responds: a conversational agent, planning multi-step work, or autonomous autopilot.',
  currentValue: 'https://agentclientprotocol.com/protocol/session-modes#agent',
  options: [
    {
      value: 'https://agentclientprotocol.com/protocol/session-modes#agent',
      name: 'Agent',
      description: 'Default agent mode for conversational interactions',
    },
    {
      value: 'https://agentclientprotocol.com/protocol/session-modes#plan',
      name: 'Plan',
      description: 'Plan mode for creating and executing multi-step plans',
    },
    {
      value: 'https://agentclientprotocol.com/protocol/session-modes#autopilot',
      name: 'Autopilot',
      description:
        'Autonomous mode that enables allow-all and runs until task completion without user interaction (experimental)',
    },
  ],
} as SessionConfigOption

const ALLOW_ALL_OPTION = {
  type: 'select',
  id: 'allow_all',
  name: 'Allow All',
  category: 'permissions',
  description: 'Controls whether Copilot prompts for approval before using tools, accessing paths, or fetching URLs.',
  currentValue: 'off',
  options: [
    { value: 'on', name: 'On', description: 'Automatically approve all tool, path, and URL requests' },
    { value: 'off', name: 'Off', description: 'Require approval for tool, path, and URL requests' },
  ],
} as SessionConfigOption

function modelOption(currentValue: string): SessionConfigOption {
  return {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    description: 'The AI model Copilot uses to generate responses.',
    currentValue,
    options: [
      { value: 'auto', name: 'Auto', description: 'Let Copilot pick the best model', _meta: null },
      {
        value: 'model-a',
        name: 'Model A',
        description: 'Model A',
        _meta: { copilotUsage: '1x', copilotEnablement: 'enabled' },
      },
      {
        value: 'model-b',
        name: 'Model B',
        description: 'Model B',
        _meta: { copilotUsage: '1x', copilotEnablement: 'enabled' },
      },
    ],
  } as SessionConfigOption
}

const EFFORT_OPTION = {
  type: 'select',
  id: 'reasoning_effort',
  name: 'Reasoning Effort',
  category: 'thought_level',
  description:
    'How much reasoning the model performs before responding. Higher effort can improve quality at the cost of speed.',
  currentValue: 'medium',
  options: [
    { value: 'low', name: 'low', description: 'Minimal reasoning before responding.' },
    { value: 'medium', name: 'medium', description: 'Balanced reasoning and speed.' },
    { value: 'high', name: 'high', description: 'More thorough reasoning; slower responses.' },
  ],
} as SessionConfigOption

const BYOK_OPTIONS = [MODE_OPTION, ALLOW_ALL_OPTION]

function subscriptionOptions(model: string): SessionConfigOption[] {
  return [MODE_OPTION, modelOption(model), EFFORT_OPTION, ALLOW_ALL_OPTION]
}

interface AcpStoreShape {
  connections: Map<string, unknown>
}

function acpStore(): AcpStoreShape {
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  return store
}

let counter = 0
const clients: Array<ReturnType<typeof createAgentClient>> = []
after(() => {
  for (const client of clients) {
    client.reset()
  }
})

// A connection that answers session/new with the recorded options and
// session/set_config_option the way Copilot does: the whole list back, with
// the chosen value current. The prompts' turns end when the test says so.
async function copilotSession(selection: Omit<AgentSelection, 'cwd'>, options: SessionConfigOption[]) {
  counter += 1
  const full: AgentSelection = { ...selection, cwd: `/tmp/copilot-model-contract-${counter}` }
  let current = options
  const setCalls: SetSessionConfigOptionRequest[] = []
  const turns: Array<(response: Record<string, unknown>) => void> = []
  const connection = {
    newSession: async () => ({ sessionId: `copilot-model-session-${counter}`, configOptions: current }),
    setSessionConfigOption: async (request: SetSessionConfigOptionRequest) => {
      setCalls.push(request)
      current = current.map((option) =>
        option.id === request.configId ? ({ ...option, currentValue: request.value } as SessionConfigOption) : option,
      )
      return { configOptions: current }
    },
    prompt: () =>
      new Promise((resolve) => {
        turns.push(resolve as (response: Record<string, unknown>) => void)
      }),
  } as unknown as AgentConnection
  acpStore().connections.set(connectionKey(full), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient({})
  clients.push(client)
  const meta = await client.createSession(full)
  const events: ChatEvent[] = []
  client.subscribe(meta.id, (event) => events.push(event))
  return { client, sessionId: meta.id, setCalls, events, endTurn: () => turns.shift()?.({ stopReason: 'end_turn' }) }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test("a subscription session's model and effort options are the ones the picker finds, in our effort vocabulary", async () => {
  const h = await copilotSession(
    { providerId: 'github-copilot', adapterId: 'copilot-subscription', model: 'model-a', apiKey: 'test-token' },
    subscriptionOptions('model-a'),
  )
  const options = h.client.sessionConfigOptions(h.sessionId) ?? undefined
  const model = findSelectOption(options, MODEL_SELECTOR)
  assert.equal(model?.id, 'model')
  assert.deepEqual(
    model?.options.map((entry) => ('value' in entry ? entry.value : undefined)),
    ['auto', 'model-a', 'model-b'],
  )
  assert.equal(model?.currentValue, 'model-a')
  const effort = findSelectOption(options, THOUGHT_LEVEL_SELECTOR)
  assert.equal(effort?.id, 'reasoning_effort')
  assert.deepEqual(
    effort?.options.map((entry) => ('value' in entry ? canonicalEffortId('copilot-subscription', entry.value) : undefined)),
    ['low', 'medium', 'high'],
  )
  // COPILOT_MODEL carried the profile's model at spawn, so session start
  // pushes no model of its own over the advertised one.
  assert.deepEqual(
    h.setCalls.filter((call) => call.configId === 'model'),
    [],
  )
})

test('switching the subscription model sets the option on the wire, and the next turn is reported on that model', async () => {
  const h = await copilotSession(
    { providerId: 'github-copilot', adapterId: 'copilot-subscription', model: 'model-a', apiKey: 'test-token' },
    subscriptionOptions('model-a'),
  )
  await h.client.setConfigOption(h.sessionId, 'model', 'model-b')
  assert.deepEqual(
    h.setCalls.map((call) => [call.configId, call.value]),
    [['model', 'model-b']],
  )
  assert.equal(findSelectOption(h.client.sessionConfigOptions(h.sessionId) ?? [], MODEL_SELECTOR)?.currentValue, 'model-b')
  await h.client.prompt(h.sessionId, 'hello', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.endTurn()
  await settle()
  const end = h.events.filter((event) => event.kind === 'turn_end').at(-1)
  assert.ok(end && end.kind === 'turn_end')
  assert.equal(end.model, 'model-b')
})

test('a BYOK session offers no model option, so no picker, and stays on the profile model', async () => {
  const h = await copilotSession(
    { providerId: 'zai', adapterId: 'copilot', model: 'glm-5.3', apiKey: 'test-key' },
    BYOK_OPTIONS,
  )
  const options = h.client.sessionConfigOptions(h.sessionId) ?? undefined
  assert.equal(findSelectOption(options, MODEL_SELECTOR), undefined)
  assert.equal(findSelectOption(options, THOUGHT_LEVEL_SELECTOR), undefined)
  assert.deepEqual(h.setCalls, [])
  await h.client.prompt(h.sessionId, 'hello', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.endTurn()
  await settle()
  const end = h.events.filter((event) => event.kind === 'turn_end').at(-1)
  assert.ok(end && end.kind === 'turn_end')
  assert.equal(end.model, 'glm-5.3')
})
