import assert from 'node:assert/strict'
import test from 'node:test'

import { NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { typedInputProblems } from '@/app/_authed/(extension-runtime)/_typed-inputs'
import { portsProblem, subgraphHandles, withPortOptions } from './subgraph-shared'

const CHOICES = [{ value: 'small' }, { value: 'large', label: 'Large' }]

function ports(inputs: Record<string, unknown>[], outputs: Record<string, unknown>[] = []) {
  return { inputs, outputs }
}

test("a text input port's choices are written as { value, label? }, each value once", () => {
  assert.equal(portsProblem(ports([{ id: 'size', label: 'Size', handleType: STRING_TYPE, options: CHOICES }])), null)
  const refusal = (port: Record<string, unknown>, outputs = false) =>
    portsProblem(outputs ? ports([], [port]) : ports([port]))
  assert.match(
    refusal({ id: 'n', label: 'N', handleType: NUMBER_TYPE, options: CHOICES }) ?? '',
    /inputs\[0\]\.options are a text input port's choices/,
  )
  assert.match(
    refusal({ id: 'o', label: 'O', handleType: STRING_TYPE, options: CHOICES }, true) ?? '',
    /outputs\[0\]\.options are a text input port's choices/,
  )
  assert.match(
    refusal({ id: 's', label: 'S', handleType: STRING_TYPE, options: [{ value: 'a' }, { value: 'a' }] }) ?? '',
    /hold "a" twice/,
  )
  assert.match(refusal({ id: 's', label: 'S', handleType: STRING_TYPE, options: [{ value: '' }] }) ?? '', /non-empty/)
  assert.match(refusal({ id: 's', label: 'S', handleType: STRING_TYPE, options: 'small' }) ?? '', /must be an array/)
})

test("a port's choices reach its handle on the card, and a value outside them is refused", () => {
  const data = {
    ports: ports([{ id: 'size', label: 'Size', handleType: STRING_TYPE, options: CHOICES }]),
    inputs: { 'in-size': 'medium' },
  }
  const [handle] = subgraphHandles(data)
  assert.deepEqual(handle.options, CHOICES)
  const [problem] = typedInputProblems(subgraphHandles(data), data)
  assert.equal(problem.path, 'inputs.in-size')
  assert.match(problem.title, /one of: small, large/)
  assert.deepEqual(typedInputProblems(subgraphHandles(data), { ...data, inputs: { 'in-size': 'large' } }), [])
  const plain = subgraphHandles({ ports: ports([{ id: 'size', label: 'Size', handleType: STRING_TYPE }]) })
  assert.equal('options' in plain[0], false, 'a port without choices takes any text')
})

test('setting choices drops a typed value outside them in the same write, and none takes them away', () => {
  const data = {
    name: 'Models',
    ports: ports([{ id: 'size', label: 'Size', handleType: STRING_TYPE }]),
    inputs: { 'in-size': 'medium', 'in-other': 'kept' },
  }
  const chosen = withPortOptions(data, 'size', CHOICES)
  assert.deepEqual(chosen.ports.inputs[0].options, CHOICES)
  assert.deepEqual((chosen as { inputs?: unknown }).inputs, { 'in-other': 'kept' })
  const keeping = withPortOptions({ ...data, inputs: { 'in-size': 'small' } }, 'size', CHOICES)
  assert.deepEqual((keeping as { inputs?: unknown }).inputs, { 'in-size': 'small' })
  const cleared = withPortOptions(chosen, 'size', [])
  assert.equal('options' in cleared.ports.inputs[0], false)
  assert.equal(cleared.name, 'Models')
})
