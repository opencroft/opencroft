// The read-only classification, pinned against the registry it describes.
//
// It is a security classification kept in a separate list from the tools it
// classifies, which is the arrangement that drifts: a tool gets renamed, a name
// stays behind, and the set silently stops meaning what it says. None of these
// tests is about whether a particular tool reads or writes — that judgement is
// the reviewer's — they are about the set being a true statement about the
// registry rather than a stale one.

import assert from 'node:assert/strict'
import test from 'node:test'

import { graphActions } from '@/app/_authed/(apps)/_server/graph-actions'
import { isApprovalGated, READ_ONLY_APP_ACTIONS, READ_ONLY_TOOLS, toolDefinitions } from './tools'

const names = new Set(toolDefinitions.map((t) => t.name))

test('every name in the set is a tool that exists', () => {
  // The failure this catches is a rename leaving its old name behind. A stale
  // entry is silent — it matches nothing, classifies nothing, and reads to the
  // next person as though the tool it names is covered.
  const missing = [...READ_ONLY_TOOLS].filter((name) => !names.has(name))
  assert.deepEqual(missing, [], 'these names are in READ_ONLY_TOOLS but are not tools')
})

test('no tool is both auto-allowed and approval-gated', () => {
  // The two classifications answer different questions — one is a property of
  // the tool, the other a policy about the surface — but they may not
  // CONTRADICT. A tool the MCP surface stops to ask about cannot also be the
  // one the chat waves through: whichever is right, the pair is incoherent,
  // and it would be invisible because the two live in different files.
  const contradictory = [...READ_ONLY_TOOLS].filter(isApprovalGated)
  assert.deepEqual(contradictory, [], 'these are in READ_ONLY_TOOLS and also wrapped in withApprovalRequired')
})

test('the set is a strict subset of the registry, and smaller than it', () => {
  // A guard against the whole registry being waved through by an edit that
  // looked like a tidy-up. Not a count, which would need updating on every new
  // tool and would be edited to match rather than read.
  assert.ok(READ_ONLY_TOOLS.size > 0, 'an empty set would silently restore the original defect')
  assert.ok(READ_ONLY_TOOLS.size < names.size, 'every tool being read-only means the criterion was not applied')
})

test('the tools deliberately excluded from the set are still excluded', () => {
  // Each of these was excluded for a stated reason, and each is the kind of
  // tool somebody later adds because it "only reads" or "only sends a toast".
  // If one is admitted, that should be a decision with this test in the diff,
  // not a line that slipped in.
  for (const name of ['db_read', 'send_toast', 'mcp_test', 'app_call']) {
    assert.equal(READ_ONLY_TOOLS.has(name), false, `${name} is excluded deliberately — see READ_ONLY_TOOLS' comment`)
  }
  for (const key of ['graph.focusNode', 'graph.commentNodes', 'graph.uncommentNodes']) {
    assert.equal(
      READ_ONLY_APP_ACTIONS.has(key),
      false,
      `${key} is excluded deliberately — see READ_ONLY_TOOLS' comment`,
    )
  }
})

// The same two guards for the app-action set, against the declarations it
// classifies: every key names an action the host App really declares, and
// none of them is one that asks for approval.
test('every read-only app action is a declared, ungated action of a host App', () => {
  const declared = new Map(graphActions.map((action) => [`graph.${action.id}`, action]))
  assert.ok(READ_ONLY_APP_ACTIONS.size > 0 && READ_ONLY_APP_ACTIONS.size < declared.size)
  for (const key of READ_ONLY_APP_ACTIONS) {
    const action = declared.get(key)
    assert.ok(action, `${key} is in READ_ONLY_APP_ACTIONS but no host App declares it`)
    assert.notEqual(action.requireApproval, true, `${key} is read-only and also asks for approval`)
  }
})
