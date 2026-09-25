import assert from 'node:assert/strict'
import test from 'node:test'

import { commandInvocation, commandToken, matchCommands } from './command-autocomplete'

const COMMANDS = [
  { name: 'plan', description: 'Plan first' },
  { name: 'create_plan', description: 'Create a plan' },
  { name: 'review', description: 'Review code', input: { hint: 'path' } },
]

// A subset of what codex-acp 1.13.1 advertises (src/CodexCommands.ts): built-in
// slash commands, and each configured skill as `$<skill>` -- a name the adapter
// declines to handle behind `/` and that works only when typed as spelled. The
// skill names are placeholders.
const WITH_SKILLS = [
  { name: 'plan', description: 'Turn plan mode on.', input: null },
  { name: 'skills', description: 'List available skills.', input: null },
  { name: 'review', description: 'Review uncommitted changes.', input: { hint: 'optional review instructions' } },
  { name: '$my-skill', description: 'Does the one thing this skill does', input: null },
  { name: '$other-skill', description: 'Another skill', input: null },
]

test('commandToken reads the token being typed, sigil included, and nothing else', () => {
  assert.equal(commandToken('/'), '/')
  assert.equal(commandToken('/rev'), '/rev')
  assert.equal(commandToken('  /rev'), '/rev')
  assert.equal(commandToken('$'), '$')
  assert.equal(commandToken('$my'), '$my')
  // A settled name (arguments being written) is not a token being typed.
  assert.equal(commandToken('/review src'), null)
  assert.equal(commandToken('$my-skill do it'), null)
  assert.equal(commandToken('/review\n'), null)
  assert.equal(commandToken('review'), null)
  assert.equal(commandToken(''), null)
})

test('commandInvocation types a `$` name as spelled and every other name behind `/`', () => {
  assert.equal(commandInvocation({ name: 'review' }), '/review')
  assert.equal(commandInvocation({ name: '$my-skill' }), '$my-skill')
})

test('matchCommands distinguishes "not a command" (null) from "no matches" ([])', () => {
  assert.equal(matchCommands(COMMANDS, 'hello'), null)
  assert.deepEqual(matchCommands(COMMANDS, '/zzz'), [])
  assert.deepEqual(matchCommands(WITH_SKILLS, '$zzz'), [])
})

test('matchCommands offers everything for a bare slash', () => {
  assert.equal(matchCommands(COMMANDS, '/')?.length, COMMANDS.length)
  // `$` names included, so a skill can be found from the key a reader knows.
  assert.deepEqual(
    matchCommands(WITH_SKILLS, '/')?.map((command) => command.name),
    WITH_SKILLS.map((command) => command.name),
  )
})

test('matchCommands offers only the `$` names for a bare `$`', () => {
  assert.deepEqual(
    matchCommands(WITH_SKILLS, '$')?.map((command) => command.name),
    ['$my-skill', '$other-skill'],
  )
})

test('a `$` with no `$` names advertised is not a command being typed', () => {
  // Null, not []: the popup must not claim Enter for a price or a variable.
  assert.equal(matchCommands(COMMANDS, '$'), null)
  assert.equal(matchCommands(COMMANDS, '$5'), null)
})

test('matchCommands matches the name after its sigil under either key', () => {
  assert.deepEqual(
    matchCommands(WITH_SKILLS, '$my')?.map((command) => command.name),
    ['$my-skill'],
  )
  assert.deepEqual(
    matchCommands(WITH_SKILLS, '/my')?.map((command) => command.name),
    ['$my-skill'],
  )
  // `$` narrows to the `$` names: `plan` is not offered for `$pl`.
  assert.deepEqual(matchCommands(WITH_SKILLS, '$pl'), [])
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
