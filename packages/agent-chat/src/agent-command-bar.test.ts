// Pins selectLeftoverConfigs/selectLeftoverBooleanOptions -- the two filters
// that decide what's left in the settings dropdown / the leftover boolean row
// once mode, effort, model and fast mode have their own icon buttons. Added
// after fast mode leaked into whichever of these its wire shape matched (a fix
// excluded it from only one of the two, since an agent may advertise it as
// either a native boolean or a two-value select).
import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import { selectLeftoverBooleanOptions, selectLeftoverConfigs } from './agent-command-bar-configs'

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
  assert.deepEqual(configs.map((c) => c.id), ['reasoning-visibility'])
})

test('selectLeftoverBooleanOptions excludes fast mode advertised as a native boolean', () => {
  const leftover = selectLeftoverBooleanOptions([
    booleanOption('fast', true),
    booleanOption('auto-continue', false),
  ])
  assert.deepEqual(leftover.map((o) => o.id), ['auto-continue'])
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
