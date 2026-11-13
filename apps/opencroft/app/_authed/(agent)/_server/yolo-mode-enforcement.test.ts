// YOLO against Codex and Copilot sessions. codex-acp 1.13.1 has no Manual Edits (its
// presets are Accept Edits, Auto and Bypass — src/AgentMode.ts), so a restore
// that could only fall back to Manual Edits by name had no fallback at all for
// it: a refused restore left the session in full access with YOLO off. These
// drive the real enforcement through the app's own engine instance, over a
// seeded connection that answers like codex-acp.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { connectionKey } from 'agent-client/agent-client'
import type { AgentConnection } from 'agent-client/connection'
import type { AgentSelection, SessionMode } from 'agent-client/types'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { setYoloMode } from '@/app/_authed/(mcp)/_server/yolo'
import { configLockedByYolo, installYoloModeEnforcement } from './yolo-mode-enforcement'

// src/AgentMode.ts, AgentMode.toSessionModeState().
const CODEX_MODES: SessionMode[] = [
  { id: 'read-only', name: 'Ask for approval', _meta: { kind: 'standard' } },
  { id: 'agent', name: 'Approve for me', _meta: { kind: 'auto_review' } },
  { id: 'agent-full-access', name: 'Full access', _meta: { kind: 'full_access' } },
]

let counter = 0

// `refuse` names mode ids the agent rejects, the way a real agent rejects a
// switch mid-turn — the ordinary reason a restore fails.
async function codexSession(refuse: string[] = []) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'codex',
    model: 'gpt-5.1-codex',
    apiKey: '',
    cwd: `/tmp/yolo-codex-${crypto.randomUUID()}`,
  }
  const setModeCalls: string[] = []
  const connection = {
    newSession: async () => ({
      sessionId: `yolo-codex-${counter}-${crypto.randomUUID()}`,
      modes: { availableModes: CODEX_MODES, currentModeId: 'agent' },
    }),
    setSessionMode: async (params: { modeId: string }) => {
      setModeCalls.push(params.modeId)
      if (refuse.includes(params.modeId)) {
        throw new Error(`refused ${params.modeId}`)
      }
      return {}
    },
    cancel: async () => {},
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const meta = await agentClient.createSession(selection)
  return { sessionId: meta.id, setModeCalls }
}

// Enforcement runs off the YOLO subscription without being awaited, so each
// step waits for the state it expects rather than for a fixed delay.
async function waitForMode(sessionId: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (agentClient.sessionModes(sessionId)?.current === expected) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(agentClient.sessionModes(sessionId)?.current, expected)
}

test('YOLO on puts a Codex session in full access, and off puts it back', async () => {
  installYoloModeEnforcement()
  const h = await codexSession()
  setYoloMode(true)
  await waitForMode(h.sessionId, 'agent-full-access')
  setYoloMode(false)
  await waitForMode(h.sessionId, 'agent')
  assert.deepEqual(h.setModeCalls, ['agent-full-access', 'agent'])
  await agentClient.deleteSession(h.sessionId)
})

test('a refused restore falls back to the most supervised Codex preset, not to staying in bypass', async () => {
  installYoloModeEnforcement()
  const h = await codexSession(['agent'])
  setYoloMode(true)
  await waitForMode(h.sessionId, 'agent-full-access')
  setYoloMode(false)
  await waitForMode(h.sessionId, 'read-only')
  assert.deepEqual(h.setModeCalls, ['agent-full-access', 'agent', 'read-only'])
  await agentClient.deleteSession(h.sessionId)
})

// YOLO against a Copilot session, whose bypass is its `allow_all` option rather
// than a mode. The seeded connection answers the way Copilot CLI 1.0.95 does:
// entering autopilot turns `allow_all` on and leaving it turns it off.
const COPILOT_MODE = (name: string) => `https://agentclientprotocol.com/protocol/session-modes#${name}`
const COPILOT_MODES: SessionMode[] = ['agent', 'plan', 'autopilot'].map((name) => ({
  id: COPILOT_MODE(name),
  name,
}))

async function copilotSession() {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'copilot',
    model: 'test-model',
    apiKey: 'test-key',
    cwd: `/tmp/yolo-copilot-${crypto.randomUUID()}`,
  }
  const state = { mode: COPILOT_MODE('agent'), allowAll: 'off' }
  const configOptions = () => [
    {
      type: 'select',
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      currentValue: state.mode,
      options: COPILOT_MODES.map((mode) => ({ value: mode.id, name: mode.name })),
    },
    {
      type: 'select',
      id: 'allow_all',
      name: 'Allow All',
      category: 'permissions',
      currentValue: state.allowAll,
      options: [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' },
      ],
    },
  ]
  const setModeCalls: string[] = []
  const connection = {
    newSession: async () => ({
      sessionId: `yolo-copilot-${counter}-${crypto.randomUUID()}`,
      modes: { availableModes: COPILOT_MODES, currentModeId: state.mode },
      configOptions: configOptions(),
    }),
    setSessionMode: async (params: { modeId: string }) => {
      setModeCalls.push(params.modeId)
      return {}
    },
    setSessionConfigOption: async (params: { configId: string; value: string }) => {
      if (params.configId === 'mode') {
        if (params.value === COPILOT_MODE('autopilot')) {
          state.allowAll = 'on'
        } else if (state.mode === COPILOT_MODE('autopilot')) {
          state.allowAll = 'off'
        }
        state.mode = params.value
      } else if (params.configId === 'allow_all') {
        state.allowAll = params.value
      }
      return { configOptions: configOptions() }
    },
    cancel: async () => {},
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const meta = await agentClient.createSession(selection)
  return { sessionId: meta.id, setModeCalls, state }
}

async function waitForAllowAll(state: { allowAll: string }, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (state.allowAll === expected) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(state.allowAll, expected)
}

test("YOLO on turns a Copilot session's allow_all on and leaves its mode, and off turns it back", async () => {
  installYoloModeEnforcement()
  const h = await copilotSession()
  setYoloMode(true)
  await waitForAllowAll(h.state, 'on')
  assert.equal(h.state.mode, COPILOT_MODE('agent'))
  setYoloMode(false)
  await waitForAllowAll(h.state, 'off')
  assert.deepEqual(h.setModeCalls, [], 'no mode is forced')
  await agentClient.deleteSession(h.sessionId)
})

test('under YOLO, allow_all is held on again after leaving autopilot turns it off', async () => {
  installYoloModeEnforcement()
  const h = await copilotSession()
  setYoloMode(true)
  await waitForAllowAll(h.state, 'on')
  await agentClient.setConfigOption(h.sessionId, 'mode', COPILOT_MODE('autopilot'))
  await agentClient.setConfigOption(h.sessionId, 'mode', COPILOT_MODE('agent'))
  // Leaving autopilot answered with `off`; the enforcement holds it on again.
  await waitForAllowAll(h.state, 'on')
  assert.equal(h.state.mode, COPILOT_MODE('agent'))
  setYoloMode(false)
  // Back to what the session had before YOLO, not to what autopilot left.
  await waitForAllowAll(h.state, 'off')
  await agentClient.deleteSession(h.sessionId)
})

test('YOLO locks the setting that holds bypass: the mode for Codex, allow_all for Copilot', async () => {
  const codex = await codexSession()
  const copilot = await copilotSession()
  setYoloMode(true)
  assert.equal(configLockedByYolo(codex.sessionId, 'mode'), true)
  assert.equal(configLockedByYolo(copilot.sessionId, 'mode'), false)
  assert.equal(configLockedByYolo(copilot.sessionId, 'allow_all'), true)
  setYoloMode(false)
  assert.equal(configLockedByYolo(codex.sessionId, 'mode'), false)
  assert.equal(configLockedByYolo(copilot.sessionId, 'allow_all'), false)
  await agentClient.deleteSession(codex.sessionId)
  await agentClient.deleteSession(copilot.sessionId)
})

test.after(async () => {
  await agentClient.reset()
})
