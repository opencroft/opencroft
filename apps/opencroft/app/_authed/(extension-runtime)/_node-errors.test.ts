import assert from 'node:assert/strict'
import test from 'node:test'

import {
  actionFailure,
  nodeErrorOf,
  problemOf,
  readNodeErrors,
  withActionError,
  withDerivedErrors,
  withNodeErrors,
} from './_node-errors'

const UNREACHABLE = { title: "Can't reach the Docker daemon", detail: 'connection refused', code: 'Exit code 1' }

test('a node with no errors reads as none', () => {
  assert.deepEqual(readNodeErrors(undefined), [])
  assert.deepEqual(readNodeErrors({}), [])
  assert.deepEqual(readNodeErrors({ __errors: 'not a list' }), [])
})

test('a stored string reads as an action error titled with it', () => {
  assert.deepEqual(readNodeErrors({ __errors: ['lamp is broken', ''] }), [
    { source: 'action', title: 'lamp is broken' },
  ])
})

test('stored entries keep their source and only the fields that hold text', () => {
  const data = {
    __errors: [
      { source: 'connection', ...UNREACHABLE, next: '', stack: 'at x' },
      { source: 'connection', detail: 'no title' },
    ],
  }
  assert.deepEqual(readNodeErrors(data), [{ source: 'connection', ...UNREACHABLE }])
})

test("reporting a source's errors replaces only that source's", () => {
  const data = { name: 'docker', __errors: [{ source: 'action', title: 'Deploy failed' }] }
  const next = withNodeErrors(data, 'connection', [UNREACHABLE])
  assert.deepEqual(next, {
    name: 'docker',
    __errors: [
      { source: 'action', title: 'Deploy failed' },
      { source: 'connection', ...UNREACHABLE },
    ],
  })
  assert.deepEqual(withNodeErrors(next, 'connection', []), data)
})

test('clearing the last error removes the key', () => {
  const next = withNodeErrors({ name: 'docker', __errors: [{ source: 'connection', title: 'x' }] }, 'connection', [])
  assert.deepEqual(next, { name: 'docker' })
  assert.equal('__errors' in next, false)
})

test('a report that changes nothing returns the same data, so nothing is written', () => {
  const empty = { name: 'docker' }
  assert.equal(withNodeErrors(empty, 'connection', []), empty)
  const failing = withNodeErrors(empty, 'connection', [UNREACHABLE])
  assert.notEqual(failing, empty)
  assert.equal(withNodeErrors(failing, 'connection', [UNREACHABLE]), failing)
  // Control: a different detail is a change.
  assert.notEqual(withNodeErrors(failing, 'connection', [{ ...UNREACHABLE, detail: 'timed out' }]), failing)
})

test("a source's unchanged errors are no change wherever they sit, so two reporting sources settle", () => {
  const check = { title: 'No connected handler' }
  const path = { title: 'Path shared with another route' }
  const both = withNodeErrors(withNodeErrors({}, 'check', [check]), 'path', [path])
  assert.deepEqual(readNodeErrors(both), [
    { source: 'check', ...check },
    { source: 'path', ...path },
  ])
  // `check` reports again from the front of the list: nothing is written.
  assert.equal(withNodeErrors(both, 'check', [check]), both)
  assert.equal(withNodeErrors(both, 'path', [path]), both)
  // Control: a changed report is still a change.
  assert.notEqual(withNodeErrors(both, 'check', [{ title: 'Other' }]), both)
})

test('a reported error without a title is dropped, and extra fields are not stored', () => {
  const next = withNodeErrors({}, 'check', [
    { title: '' },
    { title: 'Bad', extra: 'x' } as unknown as { title: string },
  ])
  assert.deepEqual(next, { __errors: [{ source: 'check', title: 'Bad' }] })
})

test('problemOf reads a problem an error was thrown with, and nothing else', () => {
  const thrown = Object.assign(new Error('flat text'), { problem: { ...UNREACHABLE, next: 'Start it.' } })
  assert.deepEqual(problemOf(thrown), { ...UNREACHABLE, next: 'Start it.' })
  assert.equal(problemOf(new Error('flat text')), undefined)
  assert.equal(problemOf(Object.assign(new Error('x'), { problem: { detail: 'no title' } })), undefined)
  assert.equal(problemOf('a string'), undefined)
  assert.equal(nodeErrorOf(null), undefined)
})

test('a failed action records its problem, or its message under its name', () => {
  assert.deepEqual(actionFailure('Deploy', Object.assign(new Error('x'), { problem: UNREACHABLE })), UNREACHABLE)
  assert.deepEqual(actionFailure('Deploy', new Error('compose said no')), {
    title: 'Deploy failed',
    detail: 'compose said no',
  })
  assert.deepEqual(actionFailure('Deploy', new Error('')), { title: 'Deploy failed' })
})

test('an action error is stored, and cleared, under the action source', () => {
  const failed = withActionError({ __errors: [{ source: 'connection', title: 'Other' }] }, UNREACHABLE)
  assert.deepEqual(failed, {
    __errors: [
      { source: 'connection', title: 'Other' },
      { source: 'action', ...UNREACHABLE },
    ],
  })
  assert.deepEqual(withActionError(failed, undefined), { __errors: [{ source: 'connection', title: 'Other' }] })
})

test('an action error another source already reports is not stored twice', () => {
  const data = { __errors: [{ source: 'deploy', ...UNREACHABLE }] }
  assert.equal(withActionError(data, UNREACHABLE), data)
  // Differing in any field, it is a different error and is stored.
  assert.deepEqual(readNodeErrors(withActionError(data, { ...UNREACHABLE, code: 'Exit code 2' })), [
    { source: 'deploy', ...UNREACHABLE },
    { source: 'action', ...UNREACHABLE, code: 'Exit code 2' },
  ])
})

test('canvas-derived errors follow the stored ones, checked, and one already stored is shown once', () => {
  const stored = readNodeErrors({ __errors: [{ source: 'action', ...UNREACHABLE }] })
  assert.deepEqual(withDerivedErrors(stored, [UNREACHABLE, { title: 'Unwired' }, { detail: 'no title' }, 'text']), [
    { source: 'action', ...UNREACHABLE },
    { source: 'canvas', title: 'Unwired' },
  ])
})

test("a repeated action failure replaces the action's own earlier entry rather than being dropped", () => {
  const data = { __errors: [{ source: 'action', ...UNREACHABLE }] }
  assert.equal(withActionError(data, UNREACHABLE), data)
  assert.deepEqual(withActionError(data, { title: 'Stop failed' }), {
    __errors: [{ source: 'action', title: 'Stop failed' }],
  })
})
