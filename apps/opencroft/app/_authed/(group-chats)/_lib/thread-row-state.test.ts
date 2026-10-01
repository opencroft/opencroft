import assert from 'node:assert/strict'
import test from 'node:test'

import { nextSessionActivity, type SessionActivity } from '@/app/_authed/(agent)/_lib/use-session-activity'
import type { SessionActivitySnapshot } from '@/lib/sse-events'
import { threadRowState } from './thread-row-state'

const KEY = 'group-chat.chat-1.agent-a.thread-1'
const STORED = { usedTokens: 50_000, contextLimit: 200_000, asOf: 1_000 }
const LIVE = { usedTokens: 150_000, contextLimit: 200_000 }

function activity(over: Partial<SessionActivity> = {}): SessionActivity {
  return {
    pending: new Set(),
    active: new Set(),
    background: new Set(),
    queued: new Set(),
    alive: new Set(),
    usage: new Map(),
    departedUsage: new Map(),
    ...over,
  }
}

function frame(over: Partial<SessionActivitySnapshot> = {}): SessionActivitySnapshot {
  return { pending: [], active: [], background: [], queued: [], alive: [], usage: {}, ...over }
}

// The list loaded with the stored reading, then the session ran live, then it
// stopped reporting (reaped, stopped, crashed) while the list stayed open.
function wentQuietAt(now: number): SessionActivity {
  const running = nextSessionActivity(activity(), frame({ alive: [KEY], usage: { [KEY]: LIVE } }), 2_000)
  return nextSessionActivity(running, frame(), now)
}

test('an idle session with messages held reads as queued, not idle', () => {
  const state = threadRowState(
    { sessionKey: KEY, lastContextUsage: null },
    activity({ alive: new Set([KEY]), queued: new Set([KEY]) }),
  )
  assert.equal(state.status, 'queued')
})

test('a pending ask reads as waiting on the person, whatever else is true', () => {
  const state = threadRowState(
    { sessionKey: KEY, lastContextUsage: null },
    activity({ alive: new Set([KEY]), active: new Set([KEY]), queued: new Set([KEY]), pending: new Set([KEY]) }),
  )
  assert.equal(state.status, 'waiting')
})

test('a live reading wins over the stored one', () => {
  const state = threadRowState(
    { sessionKey: KEY, lastContextUsage: STORED },
    activity({ alive: new Set([KEY]), usage: new Map([[KEY, LIVE]]) }),
  )
  assert.deepEqual(state, { status: 'idle', context: LIVE })
})

test('with no live reading the stored one is shown, carrying the time it is from', () => {
  const state = threadRowState({ sessionKey: KEY, lastContextUsage: STORED }, activity())
  assert.deepEqual(state, { status: 'offline', context: STORED })
})

test('a session that stops reporting keeps its last live reading, not the one from when the list loaded', () => {
  const state = threadRowState({ sessionKey: KEY, lastContextUsage: STORED }, wentQuietAt(5_000))
  assert.deepEqual(state, { status: 'offline', context: { ...LIVE, asOf: 5_000 } })
})

test('the kept reading stays dated to when the session went quiet, however many pictures follow', () => {
  const later = nextSessionActivity(wentQuietAt(5_000), frame(), 9_000)
  assert.deepEqual(later.departedUsage.get(KEY), { ...LIVE, asOf: 5_000 })
})

test('a reading stored after the session went quiet wins over the kept one', () => {
  const reloaded = { usedTokens: 60_000, contextLimit: 200_000, asOf: 7_000 }
  const state = threadRowState({ sessionKey: KEY, lastContextUsage: reloaded }, wentQuietAt(5_000))
  assert.deepEqual(state.context, reloaded)
})

test('a session that reports again drops its kept reading for the live one', () => {
  const fresh = { usedTokens: 20_000, contextLimit: 200_000 }
  const back = nextSessionActivity(wentQuietAt(5_000), frame({ alive: [KEY], usage: { [KEY]: fresh } }), 6_000)
  assert.equal(back.departedUsage.has(KEY), false)
  assert.deepEqual(threadRowState({ sessionKey: KEY, lastContextUsage: STORED }, back).context, fresh)
})

test('a session that never reported usage shows no reading rather than a zero', () => {
  const state = threadRowState({ sessionKey: KEY, lastContextUsage: null }, activity())
  assert.deepEqual(state, { status: 'offline' })
})
