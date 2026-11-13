import assert from 'node:assert/strict'
import test from 'node:test'

import { typedInputProblems } from '@/app/_authed/(extension-runtime)/_typed-inputs'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

const handles: ExtensionHandle[] = [
  { id: 'width', handleType: 'builtin.core.number', role: 'target', label: 'Width', min: 1 },
  { id: 'wired-only', handleType: 'builtin.core.boolean', role: 'target', inline: false },
  { id: 'var-', handleType: 'builtin.core.number', role: 'target', dynamic: true },
  { id: 'text-in', handleType: 'builtin.core.text-stream', role: 'target' },
  { id: 'width', handleType: 'builtin.core.number', role: 'source' },
]

test('a node with no typed values has no problems', () => {
  assert.deepEqual(typedInputProblems(handles, {}), [])
  assert.deepEqual(typedInputProblems(handles, { inputs: { width: 3, 'var-a': 2 } }), [])
})

test('a typed value its input does not take is a problem at inputs.<handle>', () => {
  assert.deepEqual(typedInputProblems(handles, { inputs: { width: 'wide' } }), [
    {
      path: 'inputs.width',
      title: 'Must be a number',
      detail: 'The input Width (width) takes a number (builtin.core.number).',
    },
  ])
  assert.equal(typedInputProblems(handles, { inputs: { width: 0 } })[0]?.title, 'Must be at least 1')
})

test('a dynamic input is matched by its prefix', () => {
  assert.equal(typedInputProblems(handles, { inputs: { 'var-a': true } })[0]?.path, 'inputs.var-a')
})

test('an input declared inline: false takes no typed value', () => {
  assert.equal(typedInputProblems(handles, { inputs: { 'wired-only': true } })[0]?.title, 'Takes no typed value')
})

test('values for undeclared or non-primitive inputs are kept without a problem', () => {
  assert.deepEqual(typedInputProblems(handles, { inputs: { gone: 'x', 'text-in': 5 } }), [])
})

test('inputs that are not an object is a problem', () => {
  assert.equal(typedInputProblems(handles, { inputs: [1] })[0]?.path, 'inputs')
  assert.equal(typedInputProblems(handles, { inputs: 'x' })[0]?.title, 'Must be an object')
})
