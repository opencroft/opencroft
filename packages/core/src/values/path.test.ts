import assert from 'node:assert/strict'
import test from 'node:test'

import { parsePath, readPath } from './path'

function read(value: unknown, path: string) {
  const parsed = parsePath(path)
  assert.ok(parsed.ok, `"${path}" parses`)
  return readPath(value, parsed.segments)
}

const body = { user: { name: 'Ada', age: 36 }, items: [{ id: 'a' }, { id: 'b' }], empty: null }

test('a dot path reads nested fields, and a segment of digits indexes a list', () => {
  assert.deepEqual(read(body, 'user.name'), { found: true, value: 'Ada' })
  assert.deepEqual(read(body, 'items.1.id'), { found: true, value: 'b' })
  assert.deepEqual(read(body, 'empty'), { found: true, value: null })
})

test('the empty path is the object itself', () => {
  assert.deepEqual(read(body, ''), { found: true, value: body })
})

test('a missing field, an index past the end, or a path through a text is not found', () => {
  assert.deepEqual(read(body, 'user.email'), { found: false })
  assert.deepEqual(read(body, 'items.2'), { found: false })
  assert.deepEqual(read(body, 'items.length'), { found: false })
  assert.deepEqual(read(body, 'user.name.0'), { found: false })
  assert.deepEqual(read(body, 'empty.x'), { found: false })
})

test('only own fields are read: an inherited one is not found', () => {
  assert.deepEqual(read(body, 'user.toString'), { found: false })
  assert.deepEqual(read(body, 'hasOwnProperty'), { found: false })
})

test('a path with an empty segment does not parse, naming where', () => {
  assert.deepEqual(parsePath('user..name'), { ok: false, error: 'The path "user..name" has an empty segment at 2' })
  assert.equal(parsePath('.user').ok, false)
  assert.equal(parsePath('user.').ok, false)
})

test('the segments that reach a prototype are refused, and reading one pollutes nothing', () => {
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    const parsed = parsePath(`a.${segment}.polluted`)
    assert.equal(parsed.ok, false, segment)
  }
  // Read past the refusal: a JSON body's own `__proto__` key is still not followed.
  const hostile = JSON.parse('{"__proto__": {"polluted": true}}')
  assert.deepEqual(readPath(hostile, ['polluted']), { found: false })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('a 1000-segment path reads to its end', () => {
  let nested: unknown = 'deep'
  for (let i = 0; i < 1000; i++) {
    nested = { k: nested }
  }
  assert.deepEqual(read(nested, Array(1000).fill('k').join('.')), { found: true, value: 'deep' })
})
