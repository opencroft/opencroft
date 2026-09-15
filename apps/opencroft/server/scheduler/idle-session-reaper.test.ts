import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import { type AgentIdleConfig, selectDueSessions } from './idle-session-reaper'

const ENABLED: AgentIdleConfig = { enabled: true, thresholdMs: 45 * 60_000 }
const DISABLED: AgentIdleConfig = { enabled: false, thresholdMs: 45 * 60_000 }

function statusesOf(entries: [string, SessionStatus][]): Map<string, SessionStatus> {
  return new Map(entries)
}

test('an idle session past its threshold, on an opted-in agent, is due', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [sessionKey])
})

test('an idle session that has not yet crossed its threshold is not due', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 10 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [])
})

test('an agent that has not opted in is never reaped, however long a session has been idle', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => DISABLED, now)

  assert.deepEqual(due, [], 'opt-in is a hard gate, not a suggestion')
})

test('an agent with no config at all (no matching node found) is never reaped', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => null, now)

  assert.deepEqual(due, [])
})

// lastActivityAt is well past the threshold in each of these three -- the
// elapsed time alone would qualify the session, so a passing test here can
// only mean the status check itself excluded it, not that time ran out.

test('a working session is never reaped, however long it has been idle by the clock', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'working']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [], 'a session with an active turn must never be silently killed')
})

test('a waiting session (blocked on a permission prompt) is never reaped, however long it has been idle by the clock', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'waiting']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [])
})

test('an already-offline session is never reaped -- nothing to unload, however long it has been idle by the clock', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'offline']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [])
})

test('a session key that is not a group-chat thread key is skipped, not thrown on', () => {
  const now = 1_000_000
  const sessionKey = 'not-a-valid-key'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [])
})

// Group-chat thread sessions are keyed `group-chat.<chat>.<agent>.<thread>`
// (a lingering colon spelling still parses). These pin that the reaper
// resolves their owning agent from the AGENT segment.

test('a group-chat thread session, idle past its threshold on an opted-in agent, is due', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, (agentSlug) => (agentSlug === 'dave' ? ENABLED : null), now)

  assert.deepEqual(due, [sessionKey], 'the AGENT segment, not the chat, is what the config lookup keys on')
})

test('a group-chat thread key in the legacy colon spelling resolves to the same owning agent', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat:my-chat:dave:standup'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, (agentSlug) => (agentSlug === 'dave' ? ENABLED : null), now)

  assert.deepEqual(due, [sessionKey])
})

test('a group-chat key that does not split into four slug segments (pre-slug thread) is skipped', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.only.two-segments'
  const sessions = [{ sessionKey, lastActivityAt: now - 46 * 60_000 }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [])
})

test('a group-chat thread of a non-opted-in agent is never reaped, alongside an opted-in one that is', () => {
  const now = 1_000_000
  const optedIn = 'group-chat.my-chat.dave.standup'
  const optedOut = 'group-chat.my-chat.erin.standup'
  const sessions = [
    { sessionKey: optedIn, lastActivityAt: now - 60 * 60_000 },
    { sessionKey: optedOut, lastActivityAt: now - 60 * 60_000 },
  ]
  const statuses = statusesOf([
    [optedIn, 'idle'],
    [optedOut, 'idle'],
  ])

  const due = selectDueSessions(sessions, statuses, (agentSlug) => (agentSlug === 'dave' ? ENABLED : DISABLED), now)

  assert.deepEqual(due, [optedIn])
})

test('each session is checked against its OWN agent -- one opted-in agent does not reap another agent’s sessions', () => {
  const now = 1_000_000
  const optedIn = 'group-chat.my-chat.dave.tab1'
  const optedOut = 'group-chat.my-chat.erin.tab1'
  const sessions = [
    { sessionKey: optedIn, lastActivityAt: now - 60 * 60_000 },
    { sessionKey: optedOut, lastActivityAt: now - 60 * 60_000 },
  ]
  const statuses = statusesOf([
    [optedIn, 'idle'],
    [optedOut, 'idle'],
  ])

  const due = selectDueSessions(sessions, statuses, (agentSlug) => (agentSlug === 'dave' ? ENABLED : DISABLED), now)

  assert.deepEqual(due, [optedIn])
})

test('due is exactly at the threshold, not only strictly past it', () => {
  const now = 1_000_000
  const sessionKey = 'group-chat.my-chat.dave.standup'
  const sessions = [{ sessionKey, lastActivityAt: now - ENABLED.thresholdMs }]
  const statuses = statusesOf([[sessionKey, 'idle']])

  const due = selectDueSessions(sessions, statuses, () => ENABLED, now)

  assert.deepEqual(due, [sessionKey])
})
