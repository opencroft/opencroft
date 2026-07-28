// Pure-function tests for the turn-summary logic behind the send-message node's
// listTurns action — status derivation, truncation, and window-to-turns splitting.
// No DB, no agent-client session store: run directly with
//   node_modules/.bin/tsx --test 'app/(extension-runtime)/_server/host-turns.test.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChatEvent } from 'agent-client/types'

import { buildTurnSummary, splitIntoTurns, truncateText, turnStatus } from './host'

test('truncateText leaves short text untouched', () => {
  const result = truncateText('hello')
  assert.equal(result.text, 'hello')
  assert.equal(result.length, 5)
})

test('truncateText cuts long text with a marker but reports the original length', () => {
  const long = 'x'.repeat(500)
  const result = truncateText(long, 400)
  assert.equal(result.text, `${'x'.repeat(400)}… [truncated]`)
  assert.equal(result.length, 500)
})

test('turnStatus is finished on a normal end_turn', () => {
  const events: ChatEvent[] = [{ kind: 'user', text: 'hi' }, { kind: 'turn_end', stopReason: 'end_turn' }]
  assert.equal(turnStatus(events, false), 'finished')
})

test('turnStatus is finished on max_tokens/refusal too — the agent completed its turn', () => {
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'max_tokens' }], false), 'finished')
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'refusal' }], false), 'finished')
})

test('turnStatus is interrupted on a cancelled stopReason', () => {
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'cancelled' }], false), 'interrupted')
})

test('turnStatus is interrupted on the synthetic "resumed" marker (restart cut the turn off)', () => {
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'resumed' }], false), 'interrupted')
})

test('turnStatus is interrupted when there is no terminal event at all (errored or process died)', () => {
  assert.equal(turnStatus([{ kind: 'user', text: 'hi' }, { kind: 'error', message: 'boom' }], false), 'interrupted')
  assert.equal(turnStatus([{ kind: 'user', text: 'hi' }], false), 'interrupted')
})

test('turnStatus reports in-progress when told so, even without a terminal event', () => {
  assert.equal(turnStatus([{ kind: 'user', text: 'hi' }], true), 'in-progress')
})

test('turnStatus prefers in-progress over a stray terminal event from a prior settlement', () => {
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'cancelled' }], true), 'in-progress')
})

// A session/load replay carries no stopReasons. The boundary loadSession
// reconstructs between two replayed turns says the turn ended and nothing more,
// so it must report neither success nor failure.
test('turnStatus is unknown for a replayed turn boundary', () => {
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'replayed' }], false), 'unknown')
})

test('turnStatus still reports the last replayed turn as interrupted', () => {
  // 'resumed' closes only the final replayed turn — the one a restart could
  // have severed. It must stay distinguishable from the reconstructed ones.
  assert.equal(turnStatus([{ kind: 'turn_end', stopReason: 'resumed' }], false), 'interrupted')
})

test('buildTurnSummary reports a replayed turn as unknown but still carries its final message', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'what changed?' },
    { kind: 'agent_message', text: 'the schema ' },
    { kind: 'agent_message', text: 'moved' },
    { kind: 'turn_end', stopReason: 'replayed' },
  ]
  const summary = buildTurnSummary(0, events, false)
  assert.equal(summary.status, 'unknown')
  // The reply was recorded in full; only its ending went unobserved.
  assert.equal(summary.finalMessage, 'the schema moved')
  assert.equal(summary.finalMessageLength, 'the schema moved'.length)
})

// Every fixture below emits the agent's reply the way the client actually
// does — one `agent_message` per content delta, not one per message. A fixture
// that puts a whole message in each event cannot catch a summary path that
// keeps the last event instead of joining the run.
test('buildTurnSummary includes a truncated finalMessage only when finished', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'hi' },
    { kind: 'agent_thought', text: 'thinking...' },
    { kind: 'agent_message', text: 'final ' },
    { kind: 'agent_message', text: 'answer' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const summary = buildTurnSummary(3, events, false)
  assert.equal(summary.index, 3)
  assert.equal(summary.status, 'finished')
  assert.equal(summary.prompt, 'hi')
  assert.equal(summary.promptLength, 2)
  assert.equal(summary.finalMessage, 'final answer')
  assert.equal(summary.finalMessageLength, 'final answer'.length)
})

test('buildTurnSummary joins the whole run of chunks a final message arrives in', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'agent_message', text: 'chunk one ' },
    { kind: 'agent_message', text: 'chunk two ' },
    { kind: 'agent_message', text: 'chunk three' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const summary = buildTurnSummary(0, events, false)
  assert.equal(summary.finalMessage, 'chunk one chunk two chunk three')
  assert.equal(summary.finalMessageLength, 'chunk one chunk two chunk three'.length)
})

test('buildTurnSummary reports the last message only, when a tool call splits the reply', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'agent_message', text: 'let me ' },
    { kind: 'agent_message', text: 'check' },
    { kind: 'tool_call', toolCallId: 't1', title: 'read', status: 'completed' },
    { kind: 'agent_message', text: 'the answer ' },
    { kind: 'agent_message', text: 'is 42' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const summary = buildTurnSummary(0, events, false)
  assert.equal(summary.finalMessage, 'the answer is 42')
})

test('buildTurnSummary truncates a long final message but reports its real length', () => {
  // The length is what tells a reader text was cut. Measuring the trailing
  // chunk instead of the joined message made a truncated answer look complete.
  const half = 'x'.repeat(300)
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'agent_message', text: half },
    { kind: 'agent_message', text: half },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const summary = buildTurnSummary(0, events, false)
  assert.equal(summary.finalMessageLength, 600)
  assert.equal(summary.finalMessage?.endsWith('… [truncated]'), true)
})

test('buildTurnSummary omits finalMessage for interrupted/in-progress turns', () => {
  const cancelled = buildTurnSummary(0, [{ kind: 'turn_end', stopReason: 'cancelled' }], false)
  assert.equal(cancelled.status, 'interrupted')
  assert.equal('finalMessage' in cancelled, false)

  const running = buildTurnSummary(0, [{ kind: 'user', text: 'hi' }, { kind: 'agent_message', text: 'partial' }], true)
  assert.equal(running.status, 'in-progress')
  assert.equal('finalMessage' in running, false)
})

test('splitIntoTurns groups events at each user boundary and tags absolute indices', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'turn A' },
    { kind: 'agent_message', text: 'reply A' },
    { kind: 'turn_end', stopReason: 'end_turn' },
    { kind: 'user', text: 'turn B' },
    { kind: 'agent_message', text: 'reply B' },
  ]
  const groups = splitIntoTurns(events, 10)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].index, 10)
  assert.equal(groups[0].events.length, 3)
  assert.equal(groups[1].index, 13)
  assert.equal(groups[1].events.length, 2)
})

test('splitIntoTurns on an empty window returns no groups', () => {
  assert.deepEqual(splitIntoTurns([], 5), [])
})

test('splitIntoTurns does not crash on a session with zero turns (snapshot events only, no user event)', () => {
  // tailByTurns returns a snapshot-only log as-is when there are no user-turn
  // boundaries to cut at (a session that was created but never prompted) — it
  // does not start with 'user' the way a real turn window always does.
  const events: ChatEvent[] = [
    { kind: 'modes', available: [], current: 'default' },
    { kind: 'config_options', options: [] },
  ]
  assert.deepEqual(splitIntoTurns(events, 0), [])
})

test('splitIntoTurns drops leading non-user events that precede the first real turn', () => {
  const events: ChatEvent[] = [
    { kind: 'modes', available: [], current: 'default' },
    { kind: 'user', text: 'turn A' },
    { kind: 'agent_message', text: 'reply A' },
  ]
  const groups = splitIntoTurns(events, 0)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].index, 1)
  assert.equal(groups[0].events.length, 2)
})
