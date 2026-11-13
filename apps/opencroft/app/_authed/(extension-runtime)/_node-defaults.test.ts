import assert from 'node:assert/strict'
import test from 'node:test'

import { newNodeData } from './_node-defaults'

const DEFAULTS = { script: '', language: 'bash', env: '', tags: ['a'] }

test('a node given no data starts with every default', () => {
  assert.deepEqual(newNodeData(DEFAULTS), DEFAULTS)
  assert.deepEqual(newNodeData(DEFAULTS, {}), DEFAULTS)
})

test('each top-level field given replaces its default, and the rest keep theirs', () => {
  assert.deepEqual(newNodeData(DEFAULTS, { script: 'echo hi', extra: 1 }), {
    script: 'echo hi',
    language: 'bash',
    env: '',
    tags: ['a'],
    extra: 1,
  })
})

test('a field given as undefined replaces its default, as a spread of the given data does', () => {
  assert.deepEqual(newNodeData(DEFAULTS, { language: undefined }), { ...DEFAULTS, language: undefined })
})

test('a type with no defaults stores the given data alone', () => {
  assert.deepEqual(newNodeData(undefined, { text: 'x' }), { text: 'x' })
  assert.deepEqual(newNodeData(undefined), {})
})

test('nodes created from one declaration share no array or object with it', () => {
  const first = newNodeData(DEFAULTS)
  ;(first.tags as string[]).push('b')

  assert.deepEqual(DEFAULTS.tags, ['a'], 'the declaration is unchanged')
  assert.deepEqual(newNodeData(DEFAULTS).tags, ['a'], 'the next node gets the declared value')
})

test('a default that is not plain data is kept as given, and the plain data around it is still copied', () => {
  const format = (value: number) => `${value} km`
  const since = new Date(0)
  const icon = Object.freeze({ type: 'svg', props: Object.freeze({}) })
  const defaults = { format, since, icon, ranges: [{ from: 0, format }] }

  const data = newNodeData(defaults)

  assert.equal(data.format, format, 'a function')
  assert.equal(data.since, since, 'a class instance')
  assert.equal(data.icon, icon, 'a frozen object, as a React element is in development')
  const ranges = data.ranges as { from: number; format: unknown }[]
  assert.notEqual(ranges, defaults.ranges)
  assert.notEqual(ranges[0], defaults.ranges[0])
  assert.deepEqual(ranges, [{ from: 0, format }])
  assert.equal(ranges[0].format, format, 'a function inside a copied object')
})
