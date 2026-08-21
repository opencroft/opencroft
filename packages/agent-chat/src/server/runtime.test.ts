// Who a composer message is attributed to.
//
// Attribution is durable in a way it was not before: the sender is written into
// the message the agent actually reads, so whatever answers "who is this from?"
// is quoted verbatim in the transcript and in every agent's view of who said
// what. These pin that the answer comes from the HOST, and that a host which
// answers nothing gets a name belonging to nobody rather than a borrowed one.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentEngine, SkillsDataLayer } from './runtime'
import { configureAgentChat, READER_FALLBACK, resolveReaderName } from './runtime'

// The runtime's other members are irrelevant here and are never called.
const unused = null as unknown as { agent: AgentEngine; skills: SkillsDataLayer }

test('the host resolves the reader name', async () => {
  configureAgentChat({ ...unused, reader: { name: () => 'Ada' } })
  assert.equal(await resolveReaderName(), 'Ada')
})

test('an async host resolver is awaited, not stringified', async () => {
  // A host reading a session cookie returns a promise. Forgetting to await it
  // would not throw -- it would attribute every message to "[object Promise]".
  configureAgentChat({ ...unused, reader: { name: async () => 'Bo' } })
  assert.equal(await resolveReaderName(), 'Bo')
})

test('a host with no reader gets a name that belongs to nobody', async () => {
  configureAgentChat({ ...unused })
  assert.equal(await resolveReaderName(), READER_FALLBACK)
})

test('the fallback names nobody on the team', () => {
  // The point of the default is that it cannot be mistaken for a person. A
  // future edit making it something like "Admin" or a hostname would quietly
  // start attributing messages to something that reads like somebody.
  assert.equal(READER_FALLBACK, 'User')
})
