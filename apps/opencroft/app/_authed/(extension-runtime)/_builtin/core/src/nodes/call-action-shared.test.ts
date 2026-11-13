import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { BOOLEAN_TYPE, NO_ENUMS, NUMBER_TYPE, OBJECT_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { declaredHandlesOf } from '@/app/_authed/(extension-runtime)/_declared-handles'
import {
  CALL_ACTION,
  CALL_ACTION_OUTCOME_OUTPUTS,
  CALL_ACTION_TYPE,
  callActionHandles,
  callActionOutputValue,
  callActionParamsOf,
  callActionTargetOf,
  paramsOfSchema,
  sameParams,
} from './call-action-shared'

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Secret name' },
    length: { type: 'number' },
    format: { type: 'string', enum: ['alphanumeric', 'symbols'] },
  },
  required: ['name'],
}

test('a schema of a text, a number and a text with an enum gives three inputs, in its order', () => {
  const result = paramsOfSchema(GENERATE_SCHEMA)
  assert.deepEqual(result, {
    ok: true,
    params: [
      { name: 'name', type: STRING_TYPE, required: true, description: 'Secret name' },
      { name: 'length', type: NUMBER_TYPE },
      {
        name: 'format',
        type: STRING_TYPE,
        options: [{ value: 'alphanumeric' }, { value: 'symbols' }],
      },
    ],
  })
})

test('an integer is a whole-number input and a boolean a boolean one', () => {
  assert.deepEqual(paramsOfSchema({ properties: { count: { type: 'integer' }, force: { type: 'boolean' } } }), {
    ok: true,
    params: [
      { name: 'count', type: NUMBER_TYPE, integer: true },
      { name: 'force', type: BOOLEAN_TYPE },
    ],
  })
})

test('an optional parameter no value input carries is not offered', () => {
  assert.deepEqual(paramsOfSchema({ properties: { tags: { type: 'array' }, name: { type: 'string' } } }), {
    ok: true,
    params: [{ name: 'name', type: STRING_TYPE }],
  })
})

test('a required parameter no value input carries makes the action unavailable, naming it', () => {
  const result = paramsOfSchema({ properties: { tags: { type: 'array' } }, required: ['tags'] })
  assert.equal(result.ok, false)
  assert.match(result.ok ? '' : result.unavailable, /"tags" takes a list, which a graph cannot pass/)
})

test('an action with no schema takes no parameters', () => {
  assert.deepEqual(paramsOfSchema(undefined), { ok: true, params: [] })
})

test('the handles are Run, one input per parameter of its type, Done and Failed', () => {
  const params = paramsOfSchema(GENERATE_SCHEMA)
  const data = { params: params.ok ? params.params : [] }
  const handles = callActionHandles(data)
  assert.deepEqual(
    handles.map((h) => [h.id, h.role, h.handleType]),
    [
      ['exec-in', 'target', 'builtin.core.execution-context'],
      ['param-name', 'target', STRING_TYPE],
      ['param-length', 'target', NUMBER_TYPE],
      ['param-format', 'target', STRING_TYPE],
      ['exec-out', 'source', 'builtin.core.execution-context'],
      ['exec-error', 'source', 'builtin.core.execution-context'],
      ['result', 'source', OBJECT_TYPE],
      ['result-text', 'source', STRING_TYPE],
      ['error', 'source', STRING_TYPE],
    ],
  )
  assert.deepEqual(
    handles.filter((h) => h.runtime === true).map((h) => h.id),
    ['result', 'result-text', 'error'],
  )
  assert.deepEqual(handles.find((h) => h.id === 'param-format')?.options, [
    { value: 'alphanumeric' },
    { value: 'symbols' },
  ])
  assert.equal(handles[0].multiple, true)
})

test('declaredHandlesOf answers a Call Action from its data, not its type', () => {
  const data = { params: [{ name: 'count', type: NUMBER_TYPE, integer: true }] }
  const handles = declaredHandlesOf({ type: CALL_ACTION_TYPE, data }, () => [], NO_ENUMS)
  assert.deepEqual(
    handles.map((h) => h.id),
    ['exec-in', 'param-count', 'exec-out', 'exec-error', 'result', 'result-text', 'error'],
  )
  assert.equal(handles[1].integer, true)
})

test("an object result is on Result, a text result on Result text, and a failure's message on Error", () => {
  assert.deepEqual(callActionOutputValue('result', { result: { name: 'K' } }), { name: 'K' })
  assert.equal(callActionOutputValue('result-text', { result: { name: 'K' } }), undefined)
  assert.equal(callActionOutputValue('error', { result: { name: 'K' } }), undefined)

  assert.equal(callActionOutputValue('result-text', { result: 'Nothing to do' }), 'Nothing to do')
  assert.equal(callActionOutputValue('result', { result: 'Nothing to do' }), undefined)

  assert.equal(callActionOutputValue('error', { error: 'No target' }), 'No target')
  assert.equal(callActionOutputValue('result', { error: 'No target' }), undefined)
})

test('a result that is a list, a number or nothing is on no output', () => {
  for (const result of [[{ name: 'K' }, { name: 'K' }], 42, null, undefined]) {
    for (const id of ['result', 'result-text', 'error']) {
      assert.equal(callActionOutputValue(id, { result }), undefined, `${id} of ${JSON.stringify(result)}`)
    }
  }
})

test('outside a run, every outcome output has nothing', () => {
  for (const handle of CALL_ACTION_OUTCOME_OUTPUTS) {
    assert.equal(callActionOutputValue(handle.id, undefined), undefined, handle.id)
  }
  // An inherited key is not an outcome.
  assert.equal(callActionOutputValue('result', Object.create({ result: { name: 'K' } })), undefined)
})

// The agents read the handles from the manifest, the canvas and the resolvers from these: they must agree.
test('the manifest declares the same outcome outputs, each `runtime: true`', () => {
  const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'extension.json'), 'utf-8')) as {
    nodes: Array<{ type: string; handles?: Array<Record<string, unknown>> }>
  }
  const declared = manifest.nodes.find((n) => n.type === CALL_ACTION)?.handles?.filter((h) => h.runtime === true)
  assert.deepEqual(
    declared,
    CALL_ACTION_OUTCOME_OUTPUTS.map((h) => ({ ...h, handleType: h.handleType.replace(/^builtin\.core\./, '') })),
  )
})

test('entries of params that are not a parameter of a value type are skipped', () => {
  const data = {
    params: [
      { name: 'ok', type: STRING_TYPE },
      { name: 'list', type: 'builtin.core.object' },
      { type: NUMBER_TYPE },
      7,
    ],
  }
  assert.deepEqual(callActionParamsOf(data), [{ name: 'ok', type: STRING_TYPE }])
})

test('a target is nodes or an app, and anything else is none', () => {
  assert.deepEqual(callActionTargetOf({ target: { nodes: ['a', '', 3, 'b'] } }), { nodes: ['a', 'b'] })
  assert.deepEqual(callActionTargetOf({ target: { app: 'instance-1' } }), { app: 'instance-1' })
  assert.equal(callActionTargetOf({ target: { nodes: [] } }), undefined)
  assert.equal(callActionTargetOf({ target: { app: ' ' } }), undefined)
  assert.equal(callActionTargetOf({ target: 'a' }), undefined)
  assert.equal(callActionTargetOf({}), undefined)
})

test('two snapshots are the same whatever order their fields were written in', () => {
  const a = [{ name: 'n', type: STRING_TYPE, required: true, description: 'd' }]
  const b = [{ description: 'd', required: true, type: STRING_TYPE, name: 'n' }]
  assert.equal(sameParams(a, b), true)
  assert.equal(sameParams(a, [{ name: 'n', type: STRING_TYPE }]), false)
})
