import assert from 'node:assert/strict'
import test from 'node:test'

import { formatSkillCatalog } from './skill-tools'

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
