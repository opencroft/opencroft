// The context a node action receives, as buildCtx assembles it. Dispatch itself
// runs a compiled extension bundle the plain test runner cannot load, so the
// rule is tested where it is decided.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { buildCtx, type GraphNodeLike } from './node-actions-impl'

const node: GraphNodeLike = { id: 'app-1', type: 'application', position: { x: 0, y: 0 }, data: {} }
const graph: GraphData = { nodes: [{ ...node }], edges: [] }

test('a run that can be cancelled hands its signal to the action', () => {
  const controller = new AbortController()
  const ctx = buildCtx(graph, node, {}, 'space', {}, undefined, controller.signal)
  assert.equal(ctx.signal, controller.signal)
  controller.abort()
  assert.equal(ctx.signal?.aborted, true)
})

test('a run nothing can cancel carries no signal field at all', () => {
  const ctx = buildCtx(graph, node, {}, 'space', {}, undefined)
  assert.equal('signal' in ctx, false)
})
