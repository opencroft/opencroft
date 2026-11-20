import assert from 'node:assert/strict'
import test from 'node:test'

import { harnessStartError } from './harness-failure'
import { type FailureSource, knownFailure, plainFailure } from './plain-failure'

// The texts below come from the code that produces them where this package
// owns it, so a reworded producer breaks these tests rather than silently
// falling through to the generic wording.

const SOURCES: readonly FailureSource[] = ['harness', 'engine']

test('a harness whose shell has no npx reads as Node.js missing, with the shell line under details', () => {
  const started = harnessStartError(
    { stderr: ['sh: 1: exec: npx: not found\n'], exit: { code: 127, signal: null } },
    new Error('ACP connection closed'),
  )
  const plain = plainFailure(started.message, 'start', 'harness')
  assert.equal(plain.title, "The agent couldn't start: Node.js isn't installed where it runs.")
  assert.match(plain.hint ?? '', /Install Node\.js/)
  assert.equal(plain.details, started.message)
})

test('the other shapes a shell gives a missing launcher read as Node.js missing', () => {
  for (const stderr of ['bash: node: command not found', "/usr/bin/env: 'node': No such file or directory"]) {
    const started = harnessStartError({ stderr: [stderr], exit: { code: 127, signal: null } }, undefined)
    assert.match(plainFailure(started.message, 'start', 'harness').title, /Node\.js isn't installed/, stderr)
  }
})

test('a spawn that found no node binary reads as Node.js missing', () => {
  const started = harnessStartError({ stderr: [], spawnError: new Error('spawn node ENOENT') }, undefined)
  assert.match(plainFailure(started.message, 'start', 'harness').title, /Node\.js isn't installed/)
})

test("a provider's refusal of the key reads as rejected", () => {
  for (const text of [
    'Codex authentication failed: 401 Unauthorized',
    'Internal error (Incorrect API key provided: sk-test-…)',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  ]) {
    assert.equal(
      plainFailure(text, 'turn', 'harness').title,
      "The model provider didn't accept the agent's key.",
      text,
    )
  }
})

test('a model server that does not answer reads as unreachable', () => {
  for (const text of [
    'connect ECONNREFUSED 10.0.0.5:8080',
    'TypeError: fetch failed',
    'getaddrinfo ENOTFOUND llm',
    'API Error: Connection error.',
  ]) {
    assert.equal(plainFailure(text, 'turn', 'harness').title, "The agent's model server can't be reached.", text)
  }
})

test('the key and unreachable-server rules read only what the harness or its provider wrote', () => {
  for (const text of ['Codex authentication failed: 401 Unauthorized', 'connect ECONNREFUSED 10.0.0.5:8080']) {
    assert.equal(knownFailure(text, 'engine'), undefined, text)
  }
})

test("a session the engine no longer holds reads as lost in a restart, in the engine's words or the harness's", () => {
  assert.match(plainFailure('Unknown session: 3f2a', 'send', 'engine').title, /session was lost/)
  assert.match(plainFailure('Internal error (Session not found)', 'turn', 'harness').title, /session was lost/)
})

// Texts the code writes for a person, about other causes, that share a word
// with a rule: none of them is reworded, whoever is taken to have written it.
test('texts already written for the reader are not read as a cause they do not state', () => {
  for (const text of [
    // An open refused for an agent whose graph node is gone.
    'Agent node not found',
    // A harness account that is not signed in, and one that lost its sign-in.
    'Claude Code is not signed in: sign in to its account first, then start the session again.',
    'Claude Code had lost its sign-in, so its connection was reset and will sign in again: send your message again.',
    // An instruction file missing under a home directory named after the runtime.
    "The instruction texts could not be read: ENOENT: no such file or directory, open '/home/node/agent/AGENTS.md'. The session started without them.",
    // One of the harness's MCP servers refusing the connection.
    'MCP server files: connect ECONNREFUSED 127.0.0.1:3100',
  ]) {
    for (const source of SOURCES) {
      assert.equal(knownFailure(text, source), undefined, `${source}: ${text}`)
    }
  }
})

test('an unknown failure at start or send says what did not happen and keeps its text under details', () => {
  assert.deepEqual(plainFailure('Internal error', 'start', 'harness'), {
    title: "The agent couldn't start.",
    hint: 'Try again. If it keeps failing, Details say why.',
    details: 'Internal error',
  })
  assert.equal(plainFailure('Internal error', 'send', 'engine').title, "Your message wasn't sent.")
})

test('an unknown report inside a turn keeps its own words as the line', () => {
  const text = 'MCP server not connected: files (sse). Use stdio or http for it.'
  assert.deepEqual(plainFailure(text, 'turn', 'engine'), { title: text })
})
