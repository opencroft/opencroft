import assert from 'node:assert/strict'
import test from 'node:test'

import { commandToken, matchCommands } from './command-autocomplete'

const COMMANDS = [
  { name: 'plan', description: 'Plan first' },
  { name: 'create_plan', description: 'Create a plan' },
  { name: 'review', description: 'Review code', input: { hint: 'path' } },
]

test('commandToken reads the token being typed and nothing else', () => {
  assert.equal(commandToken('/'), '')
  assert.equal(commandToken('/rev'), 'rev')
  assert.equal(commandToken('  /rev'), 'rev')
  // A settled name (arguments being written) is not a token being typed.
  assert.equal(commandToken('/review src'), null)
  assert.equal(commandToken('/review\n'), null)
  assert.equal(commandToken('review'), null)
  assert.equal(commandToken(''), null)
})

test('matchCommands distinguishes "not a command" (null) from "no matches" ([])', () => {
  assert.equal(matchCommands(COMMANDS, 'hello'), null)
  assert.deepEqual(matchCommands(COMMANDS, '/zzz'), [])
})

test('matchCommands offers everything for a bare slash', () => {
  assert.equal(matchCommands(COMMANDS, '/')?.length, COMMANDS.length)
})

test('matchCommands prefers prefix matches and falls back to substring', () => {
  // `/plan` prefixes `plan` alone, even though `create_plan` contains it.
  assert.deepEqual(
    matchCommands(COMMANDS, '/plan')?.map((command) => command.name),
    ['plan'],
  )
  // Nothing prefixes `_plan`, so the substring fallback finds it.
  assert.deepEqual(
    matchCommands(COMMANDS, '/_plan')?.map((command) => command.name),
    ['create_plan'],
  )
})

test('matchCommands is case-insensitive', () => {
  assert.deepEqual(
    matchCommands(COMMANDS, '/REV')?.map((command) => command.name),
    ['review'],
  )
})

test('matchCommands with no advertised commands never opens', () => {
  assert.equal(matchCommands([], '/rev'), null)
})
