// The incident, pinned: a path with a typo in it used to be WRITTEN — every
// missing intermediate became an object, the bracket spelling became a literal
// key, and the call reported success while the schedule it meant to disable
// kept firing. These tests hold the two properties the fix is made of: an
// unresolvable path is refused naming the path, and nothing is ever created
// that the caller did not address.
//
// Deliberately dependency-free (node builtins and the module under test only,
// no path aliases): the tool host imports half the server, and a rule that can
// only be exercised through it is a rule nobody tests.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveExisting, resolveForUnset, resolveForWrite } from './property-path.ts'

// The affected node's data, in shape: one live schedule, enabled.
const eventNode = () => ({
  schedules: [
    { id: 'rule-1', enabled: true, mode: 'simple', cron: '*/30 * * * *', simple: { every: 30, unit: 'minutes' } },
  ],
  runHistory: [],
  script: 'console.log(1)',
})

test('the incident path is refused by name, and nothing is created', () => {
  const data = eventNode()
  const before = JSON.stringify(data)
  const target = resolveForWrite(data, 'schedules[0].enabled')
  assert.equal(target.ok, false)
  if (!target.ok) {
    assert.match(target.reason, /"schedules\[0\]\.enabled"/, 'the refusal names the whole path')
    assert.match(target.reason, /schedules\.0\.enabled/, 'and teaches the spelling that works')
  }
  assert.equal(JSON.stringify(data), before, 'a refused path must leave the data untouched — the junk key was the defect')
})

test('the dot spelling resolves to the array element, and a boolean lands as one', () => {
  const data = eventNode()
  const target = resolveForWrite(data, 'schedules.0.enabled')
  assert.equal(target.ok, true)
  if (target.ok) {
    ;(target.parent as Record<string, unknown>)[target.key as string] = false
  }
  const rule = data.schedules[0]
  assert.equal(rule.enabled, false)
  // The consumption seam this exists for: the scheduler gates on truthiness,
  // so the string the old tool could write kept the schedule running.
  assert.equal(Boolean(rule.enabled), false, 'boolean false reads as off where it is consumed')
  assert.equal(Boolean('false'), true, 'the string form the old tool wrote reads as ON — the second half of the defect')
})

test('a typo in an intermediate segment is refused and not manufactured', () => {
  const data = eventNode()
  const target = resolveForWrite(data, 'schdules.0.enabled')
  assert.equal(target.ok, false)
  if (!target.ok) {
    assert.match(target.reason, /"schdules" is not a property/)
    assert.match(target.reason, /Nothing is created implicitly/)
  }
  assert.equal('schdules' in data, false)
})

test('a new key is still writable where writing a property means exactly that', () => {
  const data = eventNode()
  const root = resolveForWrite(data, 'title')
  assert.equal(root.ok, true)
  const nested = resolveForWrite(data, 'schedules.0.nextRunAt')
  assert.equal(nested.ok, true, 'a new key on an existing object inside an array element')
})

test('walking through an array uses canonical indexes only', () => {
  const data = eventNode()
  assert.equal(resolveForWrite(data, 'schedules.0.simple.unit').ok, true)
  const alpha = resolveForWrite(data, 'schedules.first.enabled')
  assert.equal(alpha.ok, false)
  if (!alpha.ok) {
    assert.match(alpha.reason, /is an array and "first" is not an index/)
  }
  const padded = resolveForWrite(data, 'schedules.01.enabled')
  assert.equal(padded.ok, false, '"01" is a key spelling, not index 1 — accepting both would make two paths name one slot')
})

test('an out-of-range index is refused rather than appending or punching a hole', () => {
  const out = resolveForWrite(eventNode(), 'schedules.1')
  assert.equal(out.ok, false)
  if (!out.ok) {
    assert.match(out.reason, /1 element\(s\), so index 1 does not exist/)
  }
})

test('a primitive in the middle of a path is named, not replaced with an object', () => {
  const data = eventNode()
  const target = resolveForWrite(data, 'script.language')
  assert.equal(target.ok, false)
  if (!target.ok) {
    assert.match(target.reason, /"script" is a string, which has no properties/)
  }
  assert.equal(typeof data.script, 'string', 'the old resolver would have destroyed the script to create the object')
})

test('an existing literal key containing brackets stays addressable — that is how the residue gets removed', () => {
  const data = { ...eventNode(), 'schedules[0]': { enabled: 'false' } }
  const target = resolveForUnset(data, 'schedules[0]')
  assert.equal(target.ok, true, 'brackets are ordinary key characters, so the junk key is a real, nameable property')
  if (target.ok) {
    delete (target.parent as Record<string, unknown>)[target.key as string]
  }
  assert.equal('schedules[0]' in data, false)
  assert.equal(data.schedules[0].enabled, true, 'the real array is untouched by removing the lookalike')
})

test('editing requires the property to exist, unsetting refuses what is absent', () => {
  const data = eventNode()
  assert.equal(resolveExisting(data, 'script').ok, true)
  const missing = resolveExisting(data, 'notes')
  assert.equal(missing.ok, false)
  if (!missing.ok) {
    assert.match(missing.reason, /"notes" is not a property/)
  }
  assert.equal(resolveForUnset(data, 'notes').ok, false)
})

test('unset refuses an array element, which would renumber its neighbours', () => {
  const target = resolveForUnset(eventNode(), 'schedules.0')
  assert.equal(target.ok, false)
  if (!target.ok) {
    assert.match(target.reason, /renumber/)
  }
})

test('an empty or broken path is refused whole', () => {
  assert.equal(resolveForWrite(eventNode(), '').ok, false)
  assert.equal(resolveForWrite(eventNode(), 'schedules..enabled').ok, false)
})

test('an array element itself is editable in place', () => {
  const data = { tags: ['alpha', 'beta'] }
  const target = resolveExisting(data as unknown as Record<string, unknown>, 'tags.1')
  assert.equal(target.ok, true)
  if (target.ok) {
    assert.equal((target.parent as unknown[])[target.key as number], 'beta')
  }
})
