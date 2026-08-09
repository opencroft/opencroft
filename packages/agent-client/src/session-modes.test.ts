import assert from 'node:assert/strict'
import test from 'node:test'

import { CANONICAL_MODES, type CanonicalModeInfo, canonicalModeId, classifyModes } from './session-modes'
import type { SessionMode } from './types'

// The exact list @agentclientprotocol/claude-agent-acp 0.66.0 builds in
// buildAvailableModes(), in its own order. Pinned here so that if the bridge
// renames or adds a mode, the mapping fails loudly instead of silently
// declassifying it into "unknown" — which would look like nothing more than a
// missing icon.
const CLAUDE_CODE_MODES: SessionMode[] = [
  { id: 'auto', name: 'Auto', description: 'Use a model classifier to approve/deny permission prompts' },
  { id: 'default', name: 'Manual', description: 'Standard behavior, prompts for dangerous operations' },
  { id: 'acceptEdits', name: 'Accept Edits', description: 'Auto-accept file edit operations' },
  { id: 'plan', name: 'Plan Mode', description: 'Planning mode, no actual tool execution' },
  { id: 'dontAsk', name: "Don't Ask", description: "Don't prompt for permissions, deny if not pre-approved" },
  { id: 'bypassPermissions', name: 'Bypass Permissions', description: 'Bypass all permission checks' },
]

test('every mode Claude Code advertises is classified', () => {
  const classified = classifyModes('claude-subscription', CLAUDE_CODE_MODES)
  assert.deepEqual(
    classified.map((mode) => mode.canonical?.id),
    ['auto', 'manual', 'accept-edits', 'plan', 'dont-ask', 'bypass'],
  )
})

test('both Claude adapters classify identically', () => {
  // They drive the same bridge binary and differ only in billing.
  for (const mode of CLAUDE_CODE_MODES) {
    assert.equal(
      canonicalModeId('claude', mode.id),
      canonicalModeId('claude-subscription', mode.id),
      `adapters disagree about ${mode.id}`,
    )
  }
})

test("Claude Code's `default` classifies as manual, not as a fallback", () => {
  // The wire id stayed `default` when Claude Code renamed the mode to "Manual",
  // so nothing about the id itself says what it does — it can only come from
  // the adapter table.
  assert.equal(canonicalModeId('claude', 'default'), 'manual')
  assert.equal(canonicalModeId('some-other-agent', 'default'), undefined)
})

test('an agent with no table entry is still classified by common spellings', () => {
  // The point of the generic fallback: supporting the next ACP agent should
  // usually cost nothing.
  assert.equal(canonicalModeId('brand-new-agent', 'plan'), 'plan')
  assert.equal(canonicalModeId('brand-new-agent', 'accept_edits'), 'accept-edits')
  assert.equal(canonicalModeId('brand-new-agent', 'accept-edits'), 'accept-edits')
  assert.equal(canonicalModeId('brand-new-agent', 'DontAsk'), 'dont-ask')
})

test('an unrecognised mode is left unclassified rather than guessed at', () => {
  assert.equal(canonicalModeId('claude', 'yolo-supreme'), undefined)
  const classified = classifyModes('claude', [{ id: 'yolo-supreme', name: 'Yolo Supreme' }])
  assert.equal(classified[0]?.canonical, undefined)
  // ...and it still survives the pass, because the session really does offer it.
  assert.equal(classified[0]?.name, 'Yolo Supreme')
})

test("classifyModes preserves the agent's own order and membership", () => {
  const mixed: SessionMode[] = [
    { id: 'plan', name: 'Plan Mode' },
    { id: 'mystery', name: 'Mystery' },
  ]
  const classified = classifyModes('claude', mixed)
  assert.equal(classified.length, 2)
  assert.deepEqual(
    classified.map((mode) => mode.id),
    ['plan', 'mystery'],
  )
})

test('dont-ask and bypass never collapse into each other', () => {
  // Both stop asking; they are opposites in what the silence means. Treating
  // them as one would turn "deny everything unapproved" into "allow anything".
  assert.notEqual(canonicalModeId('claude', 'dontAsk'), canonicalModeId('claude', 'bypassPermissions'))
  assert.notEqual(CANONICAL_MODES['dont-ask'].label, CANONICAL_MODES.bypass.label)
})

test('the canonical menu order is the product-specified one', () => {
  // Pinned because it is a product decision, not something derivable — it is
  // deliberately NOT a severity ramp (`auto` leads), so nothing but this test
  // would catch a well-meaning "fix" that re-sorted it into one.
  const byOrder = (Object.values(CANONICAL_MODES) as CanonicalModeInfo[])
    .sort((a, b) => a.order - b.order)
    .map((mode) => mode.label)
  assert.deepEqual(byOrder, ['Auto', 'Plan', 'Manual Edits', 'Accept Edits', 'Reject Edits', 'Bypass Permissions'])
})

test('every canonical mode carries its own id and a unique order', () => {
  const orders = (Object.values(CANONICAL_MODES) as CanonicalModeInfo[]).map((mode) => mode.order)
  assert.equal(new Set(orders).size, orders.length, 'two modes share an order')
  for (const [key, info] of Object.entries(CANONICAL_MODES)) {
    assert.equal(info.id, key, `${key} does not carry its own id`)
  }
})
