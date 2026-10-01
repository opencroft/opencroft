// The context a node action receives, as buildCtx assembles it. Dispatch itself
// runs a compiled extension bundle the plain test runner cannot load, so the
// rule is tested where it is decided.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { buildCtx, type GraphNodeLike } from './node-actions-impl'

const EXTENSION_ID = 'acme.widgets'
const node: GraphNodeLike = { id: 'app-1', type: 'acme.widgets.gauge', position: { x: 10, y: 10 }, data: {} }
const graph: GraphData = { nodes: [{ ...node }], edges: [] }

test('a run that can be cancelled hands its signal to the action', () => {
  const controller = new AbortController()
  const ctx = buildCtx(graph, node, EXTENSION_ID, {}, 'space', {}, undefined, controller.signal)
  assert.equal(ctx.signal, controller.signal)
  controller.abort()
  assert.equal(ctx.signal?.aborted, true)
})

test('a run nothing can cancel carries no signal field at all', () => {
  const ctx = buildCtx(graph, node, EXTENSION_ID, {}, 'space', {}, undefined)
  assert.equal('signal' in ctx, false)
})

test('the action is told its node type bare, under the deprecated name too', () => {
  const ctx = buildCtx(graph, node, EXTENSION_ID, {}, 'space', {}, undefined)
  assert.equal(ctx.type, 'gauge')
  assert.equal(ctx.typeId, 'gauge')
})

// A frame the node sits inside, one of the extension's own and one of another
// extension's, and a source wired into the node: graph data the action reads.
const frame = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, style: { width: 100, height: 100 } })
const wiredGraph = {
  nodes: [
    { ...node },
    frame('own-frame', 'acme.widgets.panel'),
    frame('core-frame', 'builtin.core.section'),
    { id: 'src-1', type: 'builtin.core.prompt', position: { x: 500, y: 500 }, data: { text: 'hi' } },
  ],
  edges: [{ source: 'src-1', target: 'app-1', sourceHandle: 'text-out', targetHandle: 'text-in' }],
} as unknown as GraphData

test('graph data handed to the action carries the stored, qualified types', () => {
  const ctx = buildCtx(wiredGraph, node, EXTENSION_ID, {}, 'space', {}, undefined)
  assert.deepEqual(
    ctx.connectedSources('text-in').map((source) => source.type),
    ['builtin.core.prompt'],
  )
  assert.deepEqual(
    ctx.containingNodes().map((container) => container.type),
    ['acme.widgets.panel', 'builtin.core.section'],
  )
})

// Replaces a test that held a bare name to the action's own extension only.
// That still holds for a name the extension declares (the second case); a
// bare name only core declares now means core's, as code written before types
// were qualified meant it.
test("a bare type narrowing containingNodes is the extension's own where it declares it, else core's; a qualified one any extension's", () => {
  const ctx = buildCtx(wiredGraph, node, EXTENSION_ID, {}, 'space', {}, undefined)
  assert.deepEqual(
    ctx.containingNodes('panel').map((container) => container.id),
    ['own-frame'],
  )
  assert.deepEqual(
    ctx.containingNodes('section').map((container) => container.id),
    ['core-frame'],
    'a bare name the extension does not declare, and core does, is core',
  )
  assert.deepEqual(
    ctx.containingNodes('builtin.core.section').map((container) => container.id),
    ['core-frame'],
  )

  const declaresSection = buildCtx(
    wiredGraph,
    node,
    EXTENSION_ID,
    {},
    'space',
    {},
    undefined,
    undefined,
    new Set(['acme.widgets.section']),
  )
  assert.deepEqual(
    declaresSection.containingNodes('section').map((container) => container.id),
    [],
    'a bare name the extension declares is its own, even where core has one',
  )
})

test('an input source names the qualified handle type it came through, under both names', () => {
  const resolved = {
    'text-in': {
      sourceNodeId: 'src-1',
      sourceHandleId: 'text-out',
      handleType: 'builtin.core.text-stream',
      value: 'hi',
    },
  }
  const withInput = { ...node, data: { __resolvedContexts: resolved } }
  const ctx = buildCtx(graph, withInput, EXTENSION_ID, {}, 'space', {}, undefined)
  const source = ctx.inputSource('text-in')
  assert.equal(source?.handleType, 'builtin.core.text-stream')
  assert.equal(source?.contextType, 'builtin.core.text-stream')
})
