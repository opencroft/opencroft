// Every message the Terminal component sends to open or recover a session comes from these two
// functions: `openingMessage` on each socket open (the mount and every reconnect after a drop),
// and `sessionGoneMessage` when the server says the session is gone.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ClientMessage, TerminalConfig } from '../types'
import {
  openingMessage,
  type ReattachState,
  sessionGoneMessage,
  type TerminalSource,
  tabScopedSource,
} from './session-messages'

const OPENING_TYPES = new Set(['connect', 'local', 'wsl'])

function payloadOf(message: ClientMessage): Record<string, unknown> {
  return 'payload' in message ? (message.payload as unknown as Record<string, unknown>) : {}
}

const STATES: ReattachState[] = [
  { attemptingReattach: false, sessionId: null },
  { attemptingReattach: true, sessionId: null },
  { attemptingReattach: true, sessionId: 'session-1' },
  { attemptingReattach: false, sessionId: 'session-1' },
]

const CONNECTIONS: TerminalConfig[] = [
  { type: 'local', config: { command: 'bash' } },
  { type: 'ssh', config: { host: 'example.com', port: 22, username: 'alice' } },
  { type: 'wsl', config: { distro: 'Ubuntu' } },
]

test('an attach source only ever asks to attach, by its key, on every socket open', () => {
  const source: TerminalSource = { kind: 'attach', sessionKey: 'job:abc' }
  for (const state of STATES) {
    const message = openingMessage(source, state, 80, 24)
    assert.equal(message.type, 'attach', JSON.stringify(state))
    assert.equal(payloadOf(message).sessionKey, 'job:abc')
  }
})

test('an attach source sends nothing when its session is gone', () => {
  assert.equal(sessionGoneMessage({ kind: 'attach', sessionKey: 'job:abc' }, 80, 24), null)
})

test('a connect source opens with its transport on a fresh mount, as before', () => {
  const expected = { local: 'local', ssh: 'connect', wsl: 'wsl' } as const
  for (const connection of CONNECTIONS) {
    const message = openingMessage({ kind: 'connect', connection, sessionKey: 'terminal-1' }, STATES[0], 80, 24)
    assert.equal(message.type, expected[connection.type])
    assert.equal(payloadOf(message).sessionKey, 'terminal-1')
  }
})

test('a connect source re-attaches after it has been connected once, as before', () => {
  const source: TerminalSource = { kind: 'connect', connection: CONNECTIONS[0], sessionKey: 'terminal-1' }
  const message = openingMessage(source, { attemptingReattach: true, sessionId: 'session-1' }, 80, 24)
  assert.deepEqual(message, {
    type: 'attach',
    payload: { sessionId: 'session-1', sessionKey: 'terminal-1', cols: 80, rows: 24 },
  })
})

test('a connect source falls back to a fresh session when its session is gone, as before', () => {
  for (const connection of CONNECTIONS) {
    const message = sessionGoneMessage({ kind: 'connect', connection, command: 'top' }, 80, 24)
    assert.ok(message && OPENING_TYPES.has(message.type))
    assert.equal(payloadOf(message).command, 'top')
  }
})

test('two tabs open the same keyed terminal under different keys, and one tab under the same key every time', () => {
  const source: TerminalSource = { kind: 'connect', connection: CONNECTIONS[0], sessionKey: 'terminal-1' }
  const keyIn = (tabId: string, state: ReattachState) =>
    payloadOf(openingMessage(tabScopedSource(source, tabId), state, 80, 24)).sessionKey
  assert.notEqual(keyIn('tab-a', STATES[0]), keyIn('tab-b', STATES[0]))
  assert.equal(keyIn('tab-a', STATES[0]), keyIn('tab-a', STATES[2]))
  const gone = sessionGoneMessage(tabScopedSource(source, 'tab-a'), 80, 24)
  assert.ok(gone)
  assert.equal(payloadOf(gone).sessionKey, keyIn('tab-a', STATES[0]))
})

test('a shared source opens under its own key in every tab, and says it is shared', () => {
  const source: TerminalSource = { kind: 'connect', connection: CONNECTIONS[0], sessionKey: 'node-1', shared: true }
  for (const tabId of ['tab-a', 'tab-b']) {
    const payload = payloadOf(openingMessage(tabScopedSource(source, tabId), STATES[0], 80, 24))
    assert.equal(payload.sessionKey, 'node-1')
    assert.equal(payload.shared, true)
  }
  const gone = sessionGoneMessage(tabScopedSource(source, 'tab-a'), 80, 24)
  assert.ok(gone)
  assert.equal(payloadOf(gone).shared, true)
})

test('an unshared source does not say shared', () => {
  const source: TerminalSource = { kind: 'connect', connection: CONNECTIONS[0], sessionKey: 'node-1' }
  assert.equal('shared' in payloadOf(openingMessage(tabScopedSource(source, 'tab-a'), STATES[0], 80, 24)), false)
})

test('a tab leaves an attach key and an unkeyed connect source as they are', () => {
  const attach: TerminalSource = { kind: 'attach', sessionKey: 'job:abc' }
  assert.deepEqual(tabScopedSource(attach, 'tab-a'), attach)
  const unkeyed: TerminalSource = { kind: 'connect', connection: CONNECTIONS[0] }
  assert.equal(payloadOf(openingMessage(tabScopedSource(unkeyed, 'tab-a'), STATES[0], 80, 24)).sessionKey, undefined)
})
