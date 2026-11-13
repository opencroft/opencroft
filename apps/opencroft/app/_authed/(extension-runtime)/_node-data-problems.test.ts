import assert from 'node:assert/strict'
import test from 'node:test'

import { apiRouteDataProblems } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-protection'
import {
  dataProblemsOf,
  dataRefusal,
  introducedProblems,
  refusedProblemsOf,
} from '@/app/_authed/(extension-runtime)/_node-data-problems'

const NAME = { path: 'name', title: 'Name has spaces', detail: '"a b" has a space.' }

test('keeps each problem a validator returned with a title and a path, and only their text fields', () => {
  assert.deepEqual(
    dataProblemsOf([
      { ...NAME, next: 'Use dashes.', code: '', extra: 'dropped' },
      { title: 'No field named' },
      { path: 'name' },
      'not a problem',
      null,
    ]),
    [{ ...NAME, next: 'Use dashes.' }],
  )
})

test('a validator that returns anything but a list finds nothing', () => {
  assert.deepEqual(dataProblemsOf(undefined), [])
  assert.deepEqual(dataProblemsOf(NAME), [])
})

test('a problem the data already had is not introduced while the value at its path is unchanged', () => {
  const before = { data: { name: 'a b', volumes: ['rel'], mode: 'x' }, problems: [NAME] }
  const other = { path: 'volumes.0', title: 'Not an absolute path' }
  assert.deepEqual(introducedProblems(before, before), [])
  assert.deepEqual(introducedProblems(before, { ...before, problems: [NAME, other] }), [other])
  assert.deepEqual(introducedProblems(before, { ...before, problems: [] }), [])
  // The detail reads another field, which the write changed.
  const otherDetail = { ...NAME, detail: '"a b" has a space; mode y keeps it.' }
  assert.deepEqual(introducedProblems(before, { data: { ...before.data, mode: 'y' }, problems: [otherDetail] }), [])
})

test("clearing an API Route's Value keeps its bad header a problem it already had", () => {
  const protectedRoute = { authHeader: 'Bad Header!', authToken: 'secret:ROUTE_KEY' }
  const openRoute = { authHeader: 'Bad Header!', authToken: '' }
  const before = { data: protectedRoute, problems: apiRouteDataProblems(protectedRoute) }
  const after = { data: openRoute, problems: apiRouteDataProblems(openRoute) }
  assert.notEqual(before.problems[0]?.detail, after.problems[0]?.detail, 'the detail reads the Value')
  assert.deepEqual(introducedProblems(before, after), [])
})

test('a problem whose value changed, or that the data had under another title, is introduced', () => {
  const before = { data: { name: 'a b', tags: { first: 'x' } }, problems: [NAME] }
  const overwritten = { ...NAME, detail: '"c d" has a space.' }
  assert.deepEqual(introducedProblems(before, { data: { name: 'c d' }, problems: [overwritten] }), [overwritten])
  const retitled = { ...NAME, title: 'Name is too long' }
  assert.deepEqual(introducedProblems(before, { ...before, problems: [retitled] }), [retitled])
  const nested = { path: 'tags.first', title: 'Tag has a space' }
  const tagged = { data: { ...before.data, tags: { first: 'y z' } }, problems: [nested] }
  assert.deepEqual(introducedProblems({ ...before, problems: [nested] }, tagged), [nested])
})

test('a refusal is an invalid-params refusal whose message names each node and field, carrying the problems', () => {
  const problems = [{ nodeId: 'n1', ...NAME, next: 'Use dashes.' }]
  const refusal = dataRefusal(problems)
  assert.equal(refusal.code, -32602)
  assert.equal(
    refusal.message,
    'Refused: the write would store invalid node data. Nothing was written.\nn1 name: Name has spaces. "a b" has a space. Use dashes.',
  )
  assert.deepEqual(refusedProblemsOf(refusal), problems)
})

test('any other thrown value carries no problems', () => {
  assert.equal(refusedProblemsOf({ code: -32602, message: 'Node not found: n1' }), undefined)
  assert.equal(refusedProblemsOf({ code: -32602, message: 'Refused.', problems: [{ title: 'Other' }] }), undefined)
  assert.equal(refusedProblemsOf(new Error('boom')), undefined)
  assert.equal(refusedProblemsOf(undefined), undefined)
})
