// How an agent name is matched — the comparison three call sites share and
// none of them owns.
//
// Worth its own tests precisely because it is two lines. The failure mode of a
// retyped comparison is not that it stops working; it is that one copy starts
// trimming, or lowercasing, or matching a slug, and every copy goes on
// agreeing with itself. Each assertion below pins a decision that a plausible
// "improvement" would quietly reverse.

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentNodesNamed } from './agents-impl'

const nodes = [
  { nodeId: 'agent-1', name: 'Alice' },
  { nodeId: 'agent-2', name: 'Carol' },
  { nodeId: 'agent-3', name: 'Alice' },
  { nodeId: 'agent-4', name: ' Padded ' },
]

test('an exact name returns the nodes that carry it', () => {
  assert.deepEqual(
    agentNodesNamed(nodes, 'Carol').map((n) => n.nodeId),
    ['agent-2'],
  )
})

test('every match is returned, so a caller can tell one from several', () => {
  // The whole reason this returns a list rather than a node: the membership
  // lookups take the first match and the attribution path refuses on more than
  // one, and neither policy is expressible if the comparison has already
  // chosen.
  assert.deepEqual(
    agentNodesNamed(nodes, 'Alice').map((n) => n.nodeId),
    ['agent-1', 'agent-3'],
  )
})

test('no match is an empty list, not undefined', () => {
  // Callers distinguish none from several by length, so "nothing" has to be a
  // length rather than an absence.
  assert.deepEqual(agentNodesNamed(nodes, 'Nobody'), [])
})

test('the searched name is trimmed', () => {
  // A name arriving from a credential or a tool argument carries whatever
  // whitespace it was typed with, and all three call sites trimmed it before
  // this existed.
  assert.deepEqual(
    agentNodesNamed(nodes, '  Carol  ').map((n) => n.nodeId),
    ['agent-2'],
  )
})

test('only the query is trimmed, so a node stored with padding is unreachable by name', () => {
  // The asymmetry preserved from what all three call sites did, with its real
  // consequence stated rather than implied: the bare name does not reach it
  // because the stored name is compared as stored, and the padded name does
  // not either because the query is trimmed first. Nothing matches it.
  //
  // Pinned rather than fixed. Trimming stored names too would make it
  // reachable, and would also silently merge two nodes whose names differ only
  // by whitespace — a change to who answers to a name, which is not a change
  // this comparison may make on its own.
  assert.deepEqual(agentNodesNamed(nodes, 'Padded'), [])
  assert.deepEqual(agentNodesNamed(nodes, ' Padded '), [])
})

test('the comparison is exact, never case-insensitive or slugified', () => {
  // Two agents may legitimately be named in ways that fold together, and a
  // fold here would let one be stamped as the other. The slug form is a
  // separate identifier with its own resolution and must not leak in.
  assert.deepEqual(agentNodesNamed(nodes, 'alice'), [])
  assert.deepEqual(agentNodesNamed(nodes, 'ALICE'), [])
})

test('a node with no name matches nothing, including the empty string', () => {
  // `name` is optional on the narrow shapes some callers hold. An unnamed node
  // must not become the match for a caller whose own name resolved to nothing.
  const unnamed: { nodeId: string; name?: string }[] = [{ nodeId: 'agent-x' }, { nodeId: 'agent-y', name: '' }]
  assert.deepEqual(agentNodesNamed(unnamed, ''), [{ nodeId: 'agent-y', name: '' }])
  assert.deepEqual(agentNodesNamed(unnamed.slice(0, 1), ''), [])
})
