import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareRoutePathKeys,
  describeRoute,
  matchRoutePath,
  normalizeRoutePath,
  routePathKey,
  routeUrlPath,
} from './api-route-path'

test('a path is shown with one leading slash and no empty segments', () => {
  assert.equal(normalizeRoutePath('hooks//build/'), '/hooks/build')
  assert.equal(normalizeRoutePath(''), '/')
  assert.equal(normalizeRoutePath(undefined), '/')
  assert.equal(normalizeRoutePath(42), '/')
})

test('paths that match the same requests share a key, whatever their parameters are called', () => {
  assert.equal(routePathKey('/users/:id'), routePathKey('users/:name/'))
  assert.notEqual(routePathKey('/users/:id'), routePathKey('/users/me'))
  assert.notEqual(routePathKey('/Users'), routePathKey('/users'))
  assert.equal(routePathKey(''), '/')
})

test('a route answers under the API Route prefix', () => {
  assert.equal(routeUrlPath('hooks//build'), '/api/route/hooks/build')
  assert.equal(routeUrlPath('/'), '/api/route')
})

test('a route is named by id and graph only to its own space', () => {
  const route = { nodeId: 'n1', spaceSlug: 'team', graphAddress: 'team.main' }
  assert.equal(describeRoute(route, 'team'), 'the API Route n1 on team.main')
  assert.equal(describeRoute(route, 'other'), 'a route in another space')
})

test('a request path gives a route path its parameters, segment for segment', () => {
  assert.deepEqual(matchRoutePath('/users/:id', '/users/42'), { id: '42' })
  assert.deepEqual(matchRoutePath('/', '/'), {})
  assert.equal(matchRoutePath('/users/:id', '/users'), undefined)
  assert.equal(matchRoutePath('/users/me', '/users/you'), undefined)
})

test('of two keys matching one request, the literal segment comes first', () => {
  const keys = ['/users/:', '/users/me', '/:/me']
  keys.sort(compareRoutePathKeys)
  assert.deepEqual(keys, ['/users/me', '/users/:', '/:/me'])
})
