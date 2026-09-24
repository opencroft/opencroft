// The skill tool reads the real settings row (embedded PGlite by default) — see
// @opencroft/db's test-env for how this stays off the shared database.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { writeSkills } from '@/app/_authed/(agent)/_server/skill-store'
import { formatSkillCatalog, skillToolDefinitions, skillToolHandlers } from './skill-tools'

test('formatSkillCatalog sorts entries alphabetically by name, case-insensitive', () => {
  const skills = [
    { name: 'zeta', description: 'last', body: '' },
    { name: 'Alpha', description: 'first', body: '' },
    { name: 'beta', description: 'middle', body: '' },
  ]
  assert.equal(formatSkillCatalog(skills), 'Alpha: first\nbeta: middle\nzeta: last')
})

test('formatSkillCatalog emits plain "name: description" lines with no bullet prefix', () => {
  const skills = [{ name: 'solo', description: 'only one', body: '' }]
  assert.equal(formatSkillCatalog(skills), 'solo: only one')
})

test('formatSkillCatalog returns an empty string for an empty list', () => {
  assert.equal(formatSkillCatalog([]), '')
})

function resultText(result: Record<string, unknown>): string {
  return (result.content as { text: string }[]).map((part) => part.text).join('')
}

test('the skill tool is listed beside skill_list', () => {
  assert.ok(skillToolDefinitions.some((def) => def.name === 'skill'))
})

test('the skill tool returns a skill body verbatim', async () => {
  await writeSkills([{ name: 'alpha', description: 'first', body: 'Alpha body.' }])

  const result = await skillToolHandlers.skill({ skills: ['alpha'] }, { agent: null })

  assert.equal(resultText(result), 'Alpha body.')
})

test('the skill tool labels each body when several are asked for, and names an unknown one', async () => {
  await writeSkills([
    { name: 'alpha', description: 'first', body: 'Alpha body.' },
    { name: 'beta', description: 'second', body: 'Beta body.' },
  ])

  const text = resultText(await skillToolHandlers.skill({ skills: ['alpha', 'beta', 'gone'] }, { agent: null }))

  assert.match(text, /<skill name="alpha">\nAlpha body\.\n<\/skill>/)
  assert.match(text, /<skill name="beta">\nBeta body\.\n<\/skill>/)
  assert.match(text, /Unknown skill: gone/)
})

test('the skill tool refuses an empty request instead of returning nothing', async () => {
  const text = resultText(await skillToolHandlers.skill({ skills: [] }, { agent: null }))

  assert.match(text, /provide at least one skill name/)
})
