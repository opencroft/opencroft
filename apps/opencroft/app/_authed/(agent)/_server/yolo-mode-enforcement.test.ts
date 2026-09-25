// YOLO against a Codex session. codex-acp 1.13.1 has no Manual Edits (its
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
import { installYoloModeEnforcement } from './yolo-mode-enforcement'

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

test.after(async () => {
  await agentClient.reset()
})
