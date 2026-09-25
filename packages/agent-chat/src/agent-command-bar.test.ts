// Pins selectLeftoverConfigs/selectLeftoverBooleanOptions -- the two filters
// that decide what's left in the settings dropdown / the leftover boolean row
// once mode, effort, model and fast mode have their own icon buttons. Added
// after fast mode leaked into whichever of these its wire shape matched (a fix
// excluded it from only one of the two, since an agent may advertise it as
// either a native boolean or a two-value select).
import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { canonicalModeOf } from 'agent-client/session-modes'

import {
  modeEntries,
  selectLeftoverBooleanOptions,
  selectLeftoverConfigs,
  selectOwnButtonOptions,
} from './agent-command-bar-configs'

function selectOption(id: string, currentValue: string): SessionConfigOption {
  return {
    id,
    name: id,
    type: 'select',
    currentValue,
    options: [{ value: currentValue, name: currentValue }],
  }
}

function booleanOption(id: string, currentValue: boolean): SessionConfigOption {
  return { id, name: id, type: 'boolean', currentValue }
}

test('selectLeftoverConfigs excludes fast mode advertised as a select, same as mode/effort/model', () => {
  const configs = selectLeftoverConfigs([
    selectOption('mode', 'code'),
    selectOption('effort', 'high'),
    selectOption('model', 'opus'),
    selectOption('fast', 'on'),
    selectOption('reasoning-visibility', 'summary'),
  ])
  assert.deepEqual(
    configs.map((c) => c.id),
    ['reasoning-visibility'],
  )
})

test('selectLeftoverBooleanOptions excludes fast mode advertised as a native boolean', () => {
  const leftover = selectLeftoverBooleanOptions([booleanOption('fast', true), booleanOption('auto-continue', false)])
  assert.deepEqual(
    leftover.map((o) => o.id),
    ['auto-continue'],
  )
})

test('an ordinary select option with no own button stays in the leftover configs', () => {
  const configs = selectLeftoverConfigs([selectOption('reasoning-visibility', 'summary')])
  assert.equal(configs.length, 1)
  assert.equal(configs[0].id, 'reasoning-visibility')
})

test('an ordinary boolean option with no own button stays in the leftover row', () => {
  const leftover = selectLeftoverBooleanOptions([booleanOption('auto-continue', true)])
  assert.equal(leftover.length, 1)
  assert.equal(leftover[0].id, 'auto-continue')
})

test('both selectors are empty for no config options at all', () => {
  assert.deepEqual(selectLeftoverConfigs(undefined), [])
  assert.deepEqual(selectLeftoverBooleanOptions(undefined), [])
})

// codex-acp 1.13.1, src/CodexAcpServer.ts createSessionConfigOptions() for a
// catalog model with reasoning efforts and the fast tier. The builders it
// calls: src/AgentMode.ts toConfigOption(), src/CollaborationModeConfig.ts,
// src/ModelConfigOption.ts, src/FastModeConfig.ts (boolean shape, as sent to
// a client that advertises boolean options). Option lists trimmed to what the
// assertions read.
const CODEX_CONFIG_OPTIONS: SessionConfigOption[] = [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'agent',
    options: [
      { value: 'read-only', name: 'Ask for approval', _meta: { kind: 'standard' } },
      { value: 'agent', name: 'Approve for me', _meta: { kind: 'auto_review' } },
      { value: 'agent-full-access', name: 'Full access', _meta: { kind: 'full_access' } },
    ],
  },
  {
    id: 'collaboration_mode',
    name: 'Collaboration mode',
    category: 'collaboration_mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan', description: 'Plan before making changes' },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gpt-5.1-codex',
    options: [{ value: 'gpt-5.1-codex', name: '5.1 Codex' }],
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
    ],
  },
  { id: 'fast-mode', name: 'Fast mode', category: 'model_config', type: 'boolean', currentValue: false },
]

test("Codex's effort and fast options get their own controls, found by category", () => {
  const own = selectOwnButtonOptions(CODEX_CONFIG_OPTIONS)
  assert.equal(own.mode?.id, 'mode')
  assert.equal(own.model?.id, 'model')
  assert.equal(own.effort?.id, 'reasoning_effort')
  assert.equal(own.fast?.id, 'fast-mode')
})

test("Codex's collaboration mode is the one leftover row, under its own label", () => {
  assert.deepEqual(selectLeftoverConfigs(CODEX_CONFIG_OPTIONS), [
    {
      id: 'collaboration_mode',
      label: 'Collaboration mode',
      value: 'default',
      options: [
        { value: 'default', label: 'Default' },
        { value: 'plan', label: 'Plan' },
      ],
    },
  ])
  assert.deepEqual(selectLeftoverBooleanOptions(CODEX_CONFIG_OPTIONS), [])
})

test("the mode dial reads each Codex value's stated kind", () => {
  const entries = modeEntries(CODEX_CONFIG_OPTIONS[0].type === 'select' ? CODEX_CONFIG_OPTIONS[0].options : [])
  assert.deepEqual(
    entries.map((entry) => canonicalModeOf('codex', entry)),
    ['accept-edits', 'auto', 'bypass'],
  )
})

test('an uncategorized agent keeps its controls by conventional id (the Claude and native shape)', () => {
  const own = selectOwnButtonOptions([
    selectOption('mode', 'default'),
    selectOption('effort', 'high'),
    selectOption('model', 'opus'),
    booleanOption('fast', false),
  ])
  assert.deepEqual([own.mode?.id, own.effort?.id, own.model?.id, own.fast?.id], ['mode', 'effort', 'model', 'fast'])
})
