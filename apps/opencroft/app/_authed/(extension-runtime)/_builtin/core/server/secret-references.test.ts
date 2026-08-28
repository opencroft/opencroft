import assert from 'node:assert/strict'
import test from 'node:test'

import type { GraphNodeRecord } from '@opencroft/server'

import {
  DELETE_OVERRIDE_PARAM,
  findSecretReferences,
  refuseSecretDelete,
  type SecretReference,
} from './secret-references'

function node(id: string, data: Record<string, unknown>, type = 'application'): GraphNodeRecord {
  return { id, type, position: { x: 0, y: 0 }, data }
}

/** The refusal's text, or '' when it did not refuse — so a missing refusal
 *  fails the assertion that follows rather than throwing on a null. */
function refusalText(key: string, references: SecretReference[], override = false): string {
  return refuseSecretDelete(key, references, override)?.message ?? ''
}

// ── findSecretReferences ─────────────────────────────────────────────────
// Names are matched whole, and each convention is matched the way the code
// that resolves it reads it. This decides whether a delete is refused, so a
// near-miss in either direction is a wrong answer with consequences — one
// silently breaks a service at its next deploy, the other blocks a deletion
// nobody can explain.

// ── convention 1: a `secrets` field, one name per line ───────────────────

test('finds a node whose secrets field names the key', () => {
  const nodes = [node('app-1', { name: 'reporting-worker', secrets: 'REPORT_API_TOKEN' })]
  assert.deepEqual(findSecretReferences(nodes, 'REPORT_API_TOKEN'), [
    { nodeId: 'app-1', nodeType: 'application', nodeName: 'reporting-worker' },
  ])
})

test('reads one name per line and matches only the one asked for', () => {
  const nodes = [node('app-1', { secrets: 'FIRST_TOKEN\nSECOND_TOKEN\nTHIRD_TOKEN' })]
  assert.equal(findSecretReferences(nodes, 'SECOND_TOKEN').length, 1)
  assert.deepEqual(findSecretReferences(nodes, 'FOURTH_TOKEN'), [])
})

test('ignores surrounding whitespace and blank lines', () => {
  const nodes = [node('app-1', { secrets: '\n  SPACED_TOKEN  \n\n' })]
  assert.equal(findSecretReferences(nodes, 'SPACED_TOKEN').length, 1)
})

test('matches whole names, not substrings', () => {
  const nodes = [node('app-1', { secrets: 'API_TOKEN_STAGING' })]
  assert.deepEqual(findSecretReferences(nodes, 'API_TOKEN'), [])
})

test('a node with no secrets field is not a reference', () => {
  const nodes = [node('store-1', { secretKeys: ['API_TOKEN'] }, 'core-secrets-store')]
  assert.deepEqual(findSecretReferences(nodes, 'API_TOKEN'), [])
})

// A `secrets` field that is not a string is not a reference this misses: the
// host's own resolveEnv cannot inject from one either, so nothing is holding
// that name at deploy time.
test('a non-string secrets field is not a reference', () => {
  const nodes = [node('app-1', { secrets: ['API_TOKEN'] })]
  assert.deepEqual(findSecretReferences(nodes, 'API_TOKEN'), [])
})

test('finds every referencing node, not just the first', () => {
  const nodes = [
    node('app-1', { name: 'alpha', secrets: 'SHARED_TOKEN' }),
    node('app-2', { name: 'beta', secrets: 'OTHER_TOKEN' }),
    node('app-3', { name: 'gamma', secrets: 'SHARED_TOKEN' }),
  ]
  assert.deepEqual(
    findSecretReferences(nodes, 'SHARED_TOKEN').map((r) => r.nodeId),
    ['app-1', 'app-3'],
  )
})

test('falls back to no name when the node has none', () => {
  const nodes = [node('app-1', { secrets: 'API_TOKEN' })]
  assert.equal(findSecretReferences(nodes, 'API_TOKEN')[0].nodeName, undefined)
})

// An empty key must find NOTHING rather than everything. What makes that true
// is that `referencedNames` drops blank lines, so no name it returns equals ''.
// Stop dropping them and every node with a trailing newline in its secrets
// field starts matching the empty key — which is what this pins.
test('an empty or whitespace key finds nothing', () => {
  // The trailing newline is the point of the fixture, not an accident of
  // typing it: a field edited in a textarea usually has one, and the blank
  // line it produces is exactly what an empty key would match if the parse
  // stopped dropping blanks. Without it this test passes either way.
  const nodes = [node('app-1', { secrets: 'API_TOKEN\n' })]
  assert.deepEqual(findSecretReferences(nodes, ''), [])
  assert.deepEqual(findSecretReferences(nodes, '   '), [])
})

test('an empty graph finds nothing', () => {
  assert.deepEqual(findSecretReferences([], 'API_TOKEN'), [])
})

// ── convention 2: an `apiKeySecret` field, exactly one name ──────────────
// The highest-value reference on the graph: it is an agent's provider key, so
// deleting it unnoticed takes that agent offline at its next session start.

test('finds a node whose apiKeySecret names the key', () => {
  const nodes = [node('agent-1', { name: 'writer', apiKeySecret: 'PROVIDER_KEY' }, 'agent')]
  assert.deepEqual(
    findSecretReferences(nodes, 'PROVIDER_KEY').map((r) => r.nodeId),
    ['agent-1'],
  )
})

// Matched verbatim rather than trimmed, because the agent path resolves it
// verbatim: a padded value resolves to nothing there, so it holds nothing here.
test('a padded apiKeySecret does not reference the untrimmed name', () => {
  const nodes = [node('agent-1', { apiKeySecret: '  PROVIDER_KEY  ' }, 'agent')]
  assert.deepEqual(findSecretReferences(nodes, 'PROVIDER_KEY'), [])
})

test('an empty apiKeySecret is not a reference', () => {
  const nodes = [node('agent-1', { apiKeySecret: '' }, 'agent')]
  assert.deepEqual(findSecretReferences(nodes, ''), [])
})

// ── convention 3: a `secret:NAME` value, anywhere in the data ────────────
// Value-shaped rather than field-shaped, which is what lets it reach nodes
// whose type this module knows nothing about.

test('finds secret:NAME in a header value', () => {
  const nodes = [node('agent-1', { ttsHeaders: [{ name: 'Authorization', value: 'secret:SPEECH_KEY' }] }, 'agent')]
  assert.deepEqual(
    findSecretReferences(nodes, 'SPEECH_KEY').map((r) => r.nodeId),
    ['agent-1'],
  )
})

test('finds secret:NAME on a node type this module does not know', () => {
  const nodes = [
    node('ext-1', { stages: [{ config: { headers: [{ value: 'secret:SPEECH_KEY' }] } }] }, 'some-extension-node'),
  ]
  assert.deepEqual(
    findSecretReferences(nodes, 'SPEECH_KEY').map((r) => r.nodeId),
    ['ext-1'],
  )
})

test('the name after the prefix is trimmed, as the resolver trims it', () => {
  const nodes = [node('agent-1', { ttsHeaders: [{ value: 'secret:  SPEECH_KEY  ' }] }, 'agent')]
  assert.equal(findSecretReferences(nodes, 'SPEECH_KEY').length, 1)
})

// The prefix stands in for the WHOLE value, so it only counts at the start —
// the resolver sends anything else as typed.
test('a value merely containing the prefix later is not a reference', () => {
  const nodes = [node('agent-1', { note: 'pass secret:SPEECH_KEY here' }, 'agent')]
  assert.deepEqual(findSecretReferences(nodes, 'SPEECH_KEY'), [])
})

test('the prefix with no name after it is not a reference', () => {
  const nodes = [node('agent-1', { ttsHeaders: [{ value: 'secret:' }] }, 'agent')]
  assert.deepEqual(findSecretReferences(nodes, ''), [])
})

test('a node referencing by two conventions is reported once', () => {
  const nodes = [
    node('agent-1', { apiKeySecret: 'PROVIDER_KEY', ttsHeaders: [{ value: 'secret:PROVIDER_KEY' }] }, 'agent'),
  ]
  assert.equal(findSecretReferences(nodes, 'PROVIDER_KEY').length, 1)
})

// ── refuseSecretDelete ───────────────────────────────────────────────────

test('an unreferenced secret is not refused', () => {
  assert.equal(refuseSecretDelete('API_TOKEN', [], false), null)
})

test('a referenced secret is refused, and the refusal names every node', () => {
  const references = [
    { nodeId: 'app-1', nodeType: 'application', nodeName: 'reporting-worker' },
    { nodeId: 'app-2', nodeType: 'application' },
  ]
  const refusal = refuseSecretDelete('API_TOKEN', references, false)
  assert.equal(refusal?.references.length, 2)
  assert.match(refusal?.message ?? '', /API_TOKEN/)
  assert.match(refusal?.message ?? '', /reporting-worker \(app-1\)/)
  // No name of its own, so the type identifies it — never a bare id the reader
  // has to go and look up.
  assert.match(refusal?.message ?? '', /application \(app-2\)/)
})

test('the refusal names the parameter that overrides it', () => {
  assert.match(
    refusalText('API_TOKEN', [{ nodeId: 'app-1', nodeType: 'application' }]),
    new RegExp(DELETE_OVERRIDE_PARAM),
  )
})

test('the override gets through, and it is not the default', () => {
  const references = [{ nodeId: 'app-1', nodeType: 'application' }]
  assert.equal(refuseSecretDelete('API_TOKEN', references, true), null)
  assert.notEqual(refuseSecretDelete('API_TOKEN', references, false), null)
})

test('the refusal counts the nodes it names', () => {
  assert.match(refusalText('API_TOKEN', [{ nodeId: 'app-1' }]), /named by 1 node —/)
  assert.match(refusalText('API_TOKEN', [{ nodeId: 'app-1' }, { nodeId: 'app-2' }]), /named by 2 nodes —/)
})
