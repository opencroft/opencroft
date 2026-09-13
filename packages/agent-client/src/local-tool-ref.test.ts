// What a permission gate is allowed to treat as one of the host's own tools.
//
// Every case below is a wrong permission decision if it goes the other way, so
// these are not shape tests: resolving too eagerly classifies a call by some
// other tool's declaration, and the two tools need not agree about whether
// calling them writes anything.

import assert from 'node:assert/strict'
import test from 'node:test'

import { localToolRef } from './local-tool-ref'

test("a reference through the host's own server resolves to the registered name", () => {
  assert.equal(localToolRef('mcp__local__find_nodes', 'local'), 'find_nodes')
})

test("another server's tool does not resolve", () => {
  // The one that allows what should prompt: two MCP servers may both expose a
  // tool called `read`, and only one of them is the host's to classify.
  assert.equal(localToolRef('mcp__elsewhere__find_nodes', 'local'), undefined)
  assert.equal(localToolRef('mcp__local_other__find_nodes', 'local'), undefined)
})

test('a bare name does not resolve', () => {
  // A harness's own built-in tools arrive unnamespaced, and nothing stops one
  // from being called the same thing as a host tool. Matching a bare name would
  // answer for a tool this host never registered.
  assert.equal(localToolRef('find_nodes', 'local'), undefined)
  assert.equal(localToolRef('Read', 'local'), undefined)
})

test('the namespace alone does not resolve', () => {
  // An empty name would look up the empty string in the host's registry; a set
  // that happened to contain it would auto-allow every such request.
  assert.equal(localToolRef('mcp__local__', 'local'), undefined)
})

test('a request that names no tool does not resolve', () => {
  assert.equal(localToolRef(undefined, 'local'), undefined)
  assert.equal(localToolRef(null, 'local'), undefined)
  assert.equal(localToolRef('', 'local'), undefined)
})
