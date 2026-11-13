// A Switch between an execution producer and two handlers, on the real
// database and the real builtin/core extension bundle: the execution reaches
// only the handler on the output its condition picks, whether the condition is
// typed on the Switch, wired from a Math Expression, a text matched against
// its cases, or a typed value on an enum that is none of its cases.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { dispatchExecutionContext } from './exec-dispatch'

const handler = (side: string) => ({
  language: 'node',
  script: `function handler() { return { status: 200, body: { side: ${JSON.stringify(side)} } }; }`,
})

type Spec = { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }

// An Event feeding a Switch, whose two outputs each feed a handler.
function wiring(prefix: string, switchData: Record<string, unknown>, outputs: [string, string][], extra: Spec) {
  const n = (name: string) => `${prefix}-${name}`
  return {
    nodes: [
      { id: n('event'), type: 'builtin.core.event', data: {} },
      { id: n('sw'), type: 'builtin.core.switch', data: switchData },
      ...outputs.map(([, side]) => ({ id: n(side), type: 'script', data: handler(side) })),
      ...extra.nodes,
    ],
    edges: [
      { source: n('event'), sourceHandle: 'exec-out', target: n('sw'), targetHandle: 'exec-in' },
      ...outputs.map(([output, side]) => ({
        source: n('sw'),
        sourceHandle: output,
        target: n(side),
        targetHandle: 'exec-in',
      })),
      ...extra.edges,
    ],
  }
}

async function routed(
  name: string,
  switchData: Record<string, unknown>,
  outputs: [string, string][],
  extra?: (n: (s: string) => string) => Spec,
) {
  const slugBase = `${name}-${crypto.randomUUID()}`
  const prefix = slugBase.slice(-8)
  const n = (s: string) => `${prefix}-${s}`
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const spec = wiring(prefix, switchData, outputs, extra?.(n) ?? { nodes: [], edges: [] })
  await registry.create(slugBase, slugBase, {
    nodes: spec.nodes.map((node, i) => ({ position: { x: 0, y: i * 200 }, ...node })),
    edges: spec.edges.map((e, i) => ({ id: `${prefix}-e${i}`, ...e })),
  } as never)
  const summary = await dispatchExecutionContext({ sourceNodeId: n('event'), sourceHandleId: 'exec-out', event: {} })
  return summary.primary
}

const BOTH: [string, string][] = [
  ['exec-true', 'yes'],
  ['exec-false', 'no'],
]

test('a Switch with its condition typed routes to the side it picks', async () => {
  assert.deepEqual((await routed('switch-typed-true', { inputs: { condition: true } }, BOTH)).body, { side: 'yes' })
  assert.deepEqual((await routed('switch-typed-false', { inputs: { condition: false } }, BOTH)).body, { side: 'no' })
})

test('a Switch with its condition wired from a Math Expression routes on what it computes', async () => {
  const math = (x: number) => (n: (s: string) => string) => ({
    nodes: [
      { id: n('math'), type: 'builtin.core.math-expression', data: { expression: 'x > 2', inputs: { 'var-x': x } } },
    ],
    edges: [{ source: n('math'), sourceHandle: 'result', target: n('sw'), targetHandle: 'condition' }],
  })
  // The typed value the edge wins over says the opposite.
  assert.deepEqual((await routed('switch-wired-3', { inputs: { condition: false } }, BOTH, math(3))).body, {
    side: 'yes',
  })
  assert.deepEqual((await routed('switch-wired-1', { inputs: { condition: true } }, BOTH, math(1))).body, {
    side: 'no',
  })
})

test('a text Switch routes a case to its output and any other text to Default', async () => {
  const text = (value: string) => ({
    inputTypes: { condition: 'builtin.core.string' },
    cases: [
      { id: 'c1', value: 'draft' },
      { id: 'c2', value: 'review' },
    ],
    inputs: { condition: value },
  })
  const outputs: [string, string][] = [
    ['case-c2', 'review'],
    ['exec-default', 'other'],
  ]
  assert.deepEqual((await routed('switch-text-review', text('review'), outputs)).body, { side: 'review' })
  assert.deepEqual((await routed('switch-text-published', text('published'), outputs)).body, { side: 'other' })
})

test('a Switch on an enum routes a typed condition that is not one of its cases to Default', async () => {
  // No installed extension declares the enum, so it has no cases at all.
  const onEnum = { inputTypes: { condition: 'acme.images.format' }, inputs: { condition: 'hello' } }
  const primary = await routed('switch-enum-not-a-case', onEnum, [['exec-default', 'other']])
  assert.deepEqual(primary.body, { side: 'other' })
})

test('a boolean Switch with a number wired into its condition fails naming both types', async () => {
  const number = (n: (s: string) => string) => ({
    nodes: [{ id: n('number'), type: 'builtin.core.value', data: { valueType: 'builtin.core.number', value: 3 } }],
    edges: [{ source: n('number'), sourceHandle: 'value', target: n('sw'), targetHandle: 'condition' }],
  })
  const primary = await routed('switch-wrong-type', {}, BOTH, number)
  assert.equal(primary.status, 500)
  assert.match(primary.error ?? '', /condition is a number, and a boolean Switch routes on true or false$/)
})

test('nothing connected on the chosen output answers the dispatcher\'s "No target connected"', async () => {
  const primary = await routed('switch-unwired', { inputs: { condition: true } }, [['exec-false', 'no']])
  assert.equal(primary.status, 500)
  assert.match(primary.error ?? '', /^No target connected to .*-sw\/exec-true$/)
})
