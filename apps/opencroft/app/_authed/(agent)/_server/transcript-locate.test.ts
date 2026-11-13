import assert from 'node:assert/strict'
import test from 'node:test'

import { arrayLogReader, type LogReader, MISSING_ENTRY } from 'agent-client/pagination'
import type { ChatEvent } from 'agent-client/types'

import { locateTurn } from './transcript-locate'

const user = (text: string): ChatEvent => ({ kind: 'user', text })
const reply = (text: string): ChatEvent => ({ kind: 'agent_message', text })
const known = async () => true
const unknown = async () => false

test('a hit is found where its position stands, in what is held and below it alike', async () => {
  // Held from 10, with the history below read back from the store.
  const held = arrayLogReader([user('newer'), reply('newer answer')], 10)
  const below: ChatEvent[] = [user('old'), reply('old answer')]
  const reader: LogReader = {
    end: held.end,
    read: async (from, to) =>
      from >= 10 ? held.read(from, to) : { start: from, events: below.slice(from - 8, Math.min(to, 10) - 8) },
    turnStartBefore: held.turnStartBefore,
  }
  assert.deepEqual(await locateTurn(reader, 10, unknown), { kind: 'found', index: 10 })
  assert.deepEqual(await locateTurn(reader, 9, unknown), { kind: 'found', index: 9 })
})

test('a hit on history the settings trimmed is older than what is kept, and one nothing knows is gone', async () => {
  const trimmed: LogReader = { ...arrayLogReader([user('kept')], 5), read: async () => ({ start: 5, events: [] }) }
  assert.deepEqual(await locateTurn(trimmed, 2, known), { kind: 'older' })
  assert.deepEqual(await locateTurn(trimmed, 2, unknown), { kind: 'gone' })
})

test('a hit on a missing row is not found there', async () => {
  const reader = arrayLogReader([user('a'), MISSING_ENTRY])
  assert.deepEqual(await locateTurn(reader, 1, unknown), { kind: 'gone' })
})

test('a hit past the log, or for a session with no base, is gone unless the index knows it', async () => {
  const reader = arrayLogReader([user('a')])
  assert.deepEqual(await locateTurn(reader, 3, unknown), { kind: 'gone' })
  assert.deepEqual(await locateTurn(reader, null, unknown), { kind: 'gone' })
  assert.deepEqual(await locateTurn(reader, null, known), { kind: 'older' })
})
