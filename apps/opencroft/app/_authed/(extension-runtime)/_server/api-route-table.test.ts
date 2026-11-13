import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeRoutePath,
  PATH_ERROR_CODE,
  PATH_ERROR_SOURCE,
  routePathKey,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-path'
import { NODE_ERRORS_KEY } from '@/app/_authed/(extension-runtime)/_node-errors'
import { matchRoute, type RouteNode, routePathErrors, routeTable, type ServingMemory } from './api-route-table'

function route(nodeId: string, path: string, pathErrorCode?: string, spaceSlug = 'team'): RouteNode {
  const data: Record<string, unknown> = { path }
  if (pathErrorCode) {
    data[NODE_ERRORS_KEY] = [{ source: PATH_ERROR_SOURCE, title: 'stored', code: pathErrorCode }]
  }
  return {
    nodeId,
    spaceSlug,
    graphAddress: `${spaceSlug}.main`,
    path: normalizeRoutePath(path),
    key: routePathKey(path),
    data,
  }
}

function servedBy(routes: RouteNode[], memory: ServingMemory, requestPath: string): string | undefined {
  const match = matchRoute(routeTable(routes, memory), requestPath)
  return match.kind === 'route' ? match.route.nodeId : match.kind
}

test('a route alone on its path serves it, with its own parameter names', () => {
  const match = matchRoute(routeTable([route('a', '/users/:id')], new Map()), '/users/7')
  assert.equal(match.kind, 'route')
  assert.equal(match.kind === 'route' && match.route.nodeId, 'a')
  assert.deepEqual(match.kind === 'route' && match.params, { id: '7' })
})

test('a request no path matches reaches no route', () => {
  assert.equal(servedBy([route('a', '/hooks')], new Map(), '/other'), 'none')
})

test('the route that was serving a path keeps it when another route takes the path', () => {
  const memory: ServingMemory = new Map()
  assert.equal(servedBy([route('a', '/hooks/build')], memory, '/hooks/build'), 'a')
  // A pasted copy: same data, so the same (absent) errors.
  assert.equal(servedBy([route('copy', '/hooks/build'), route('a', '/hooks/build')], memory, '/hooks/build'), 'a')
})

test('without memory, the stored errors tell which route served the path', () => {
  const routes = [route('new', '/hooks', PATH_ERROR_CODE.taken), route('old', '/hooks', PATH_ERROR_CODE.held)]
  assert.equal(servedBy(routes, new Map(), '/hooks'), 'old')
  const unrecorded = [route('new', '/hooks', PATH_ERROR_CODE.taken), route('old', '/hooks')]
  assert.equal(servedBy(unrecorded, new Map(), '/hooks'), 'old')
})

test('routes sharing a path that none was known to serve: no route gets the request', () => {
  assert.equal(servedBy([route('a', '/hooks'), route('b', '/hooks/')], new Map(), '/hooks'), 'shared')
  const recorded = [route('a', '/hooks', PATH_ERROR_CODE.shared), route('b', '/hooks', PATH_ERROR_CODE.shared)]
  assert.equal(servedBy(recorded, new Map(), '/hooks'), 'shared')
})

test('the remembered holder is forgotten once its path is gone', () => {
  const memory: ServingMemory = new Map()
  servedBy([route('a', '/hooks')], memory, '/hooks')
  servedBy([route('a', '/moved')], memory, '/moved')
  assert.equal(memory.has(routePathKey('/hooks')), false)
  assert.equal(servedBy([route('b', '/hooks'), route('c', '/hooks')], memory, '/hooks'), 'shared')
})

test('a literal segment wins over a parameter, and a shared specific path does not fall through', () => {
  const routes = [route('param', '/users/:id'), route('me', '/users/me')]
  assert.equal(servedBy(routes, new Map(), '/users/me'), 'me')
  assert.equal(servedBy(routes, new Map(), '/users/7'), 'param')
  const shared = [...routes, route('me-too', '/users/me')]
  assert.equal(servedBy(shared, new Map(), '/users/me'), 'shared')
})

test('every route sharing a path holds an error naming the others; a route alone holds none', () => {
  const memory: ServingMemory = new Map([[routePathKey('/hooks'), 'old']])
  const errors = routePathErrors(
    routeTable([route('old', '/hooks'), route('new', '/hooks'), route('solo', '/solo')], memory),
  )
  assert.deepEqual(errors.get('solo'), [])
  const [held] = errors.get('old') ?? []
  assert.equal(held.code, PATH_ERROR_CODE.held)
  assert.match(held.detail ?? '', /the API Route new on team\.main/)
  const [taken] = errors.get('new') ?? []
  assert.equal(taken.code, PATH_ERROR_CODE.taken)
  assert.match(taken.detail ?? '', /served by the API Route old on team\.main/)

  const shared = routePathErrors(routeTable([route('a', '/x'), route('b', '/x')], new Map()))
  assert.equal(shared.get('a')?.[0].code, PATH_ERROR_CODE.shared)
  assert.match(shared.get('a')?.[0].detail ?? '', /API Route b .*409/)
})

test('routes in different spaces share one table, and each names the other only as in another space', () => {
  const memory: ServingMemory = new Map([[routePathKey('/hooks'), 'mine']])
  const routes = [route('mine', '/hooks'), route('theirs', '/hooks', undefined, 'elsewhere')]
  assert.equal(servedBy(routes, memory, '/hooks'), 'mine')
  const errors = routePathErrors(routeTable(routes, memory))
  const [held] = errors.get('mine') ?? []
  assert.match(held.detail ?? '', /also the path of a route in another space\./)
  const [taken] = errors.get('theirs') ?? []
  assert.equal(taken.detail, '/hooks is served by a route in another space, so this route gets no requests.')
  assert.doesNotMatch(`${held.detail} ${taken.detail}`, /mine|theirs|team\.main|elsewhere\.main/)
})
