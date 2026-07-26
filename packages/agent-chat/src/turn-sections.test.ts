import assert from 'node:assert/strict'
import test from 'node:test'

import { groupIntoTurnSections } from './turn-sections'

// Mirrors the shape of a real block list: a discriminated union, so the
// helper's narrowing of `section.user` is exercised rather than bypassed.
type Block = { id: string; kind: 'user' } | { id: string; kind: 'chain' }

const user = (id: string): Block => ({ id, kind: 'user' })
const chain = (id: string): Block => ({ id, kind: 'chain' })

test('each user message starts a section that owns the reply blocks after it', () => {
  const sections = groupIntoTurnSections([user('u1'), chain('c1'), chain('c2'), user('u2'), chain('c3')])
  assert.equal(sections.length, 2)
  assert.equal(sections[0].user?.id, 'u1')
  assert.deepEqual(
    sections[0].items.map((block) => block.id),
    ['c1', 'c2'],
  )
  assert.equal(sections[1].user?.id, 'u2')
  assert.deepEqual(
    sections[1].items.map((block) => block.id),
    ['c3'],
  )
})

test('a window starting mid-turn yields a leading section with no user message', () => {
  // The render window is end-anchored, so its first block can be a reply whose
  // own user message is scrolled out of the window entirely.
  const sections = groupIntoTurnSections([chain('c0'), user('u1'), chain('c1')])
  assert.equal(sections.length, 2)
  assert.equal(sections[0].user, undefined)
  assert.deepEqual(
    sections[0].items.map((block) => block.id),
    ['c0'],
  )
  assert.equal(sections[0].id, 'c0')
  assert.equal(sections[1].user?.id, 'u1')
})

test('a section id is its first block id, so it is stable across prepends', () => {
  const blocks = [user('u1'), chain('c1')]
  const before = groupIntoTurnSections(blocks)
  const after = groupIntoTurnSections([user('u0'), chain('c0'), ...blocks])
  assert.equal(before[0].id, 'u1')
  assert.equal(after.at(-1)?.id, 'u1')
})

test('consecutive user messages each get their own section', () => {
  // Two prompts sent before the agent replies: the second must not be swallowed
  // into the first's section, or it would never become a sticky header.
  const sections = groupIntoTurnSections([user('u1'), user('u2'), chain('c1')])
  assert.deepEqual(
    sections.map((section) => section.user?.id),
    ['u1', 'u2'],
  )
  assert.deepEqual(sections[0].items, [])
  assert.deepEqual(
    sections[1].items.map((block) => block.id),
    ['c1'],
  )
})

test('an empty block list produces no sections', () => {
  assert.deepEqual(groupIntoTurnSections([]), [])
})

test('every input block appears exactly once, in order', () => {
  const blocks = [chain('c0'), user('u1'), chain('c1'), user('u2'), chain('c2'), chain('c3')]
  const flattened = groupIntoTurnSections(blocks).flatMap((section) =>
    section.user ? [section.user, ...section.items] : section.items,
  )
  assert.deepEqual(flattened, blocks)
})
