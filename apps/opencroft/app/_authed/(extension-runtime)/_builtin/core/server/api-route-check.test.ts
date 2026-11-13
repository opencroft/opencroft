import assert from 'node:assert/strict'
import test from 'node:test'

import { apiRouteCheck } from './api-route-check'

const ROUTE = { id: 'route' }

test('a route with nothing on its Handler output has "No connected handler"', () => {
  assert.deepEqual(apiRouteCheck(ROUTE, []), [
    {
      title: 'No connected handler',
      detail: 'This route answers every request with 502 until something handles it.',
      next: 'Connect the Handler output to the node that should answer the request.',
    },
  ])
})

test('a route with an edge from its Handler output has no finding', () => {
  assert.deepEqual(apiRouteCheck(ROUTE, [{ source: 'route', sourceHandle: 'exec-out', target: 'script' }]), [])
})

test('an edge into the route, or from another handle, does not count as a handler', () => {
  const edges = [
    { source: 'other', sourceHandle: 'exec-out', target: 'route', targetHandle: 'exec-in' },
    { source: 'route', sourceHandle: 'other-out', target: 'script' },
    { source: 'route', sourceHandle: null, target: 'script' },
  ]
  assert.equal(apiRouteCheck(ROUTE, edges).length, 1)
})
