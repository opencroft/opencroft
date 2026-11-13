import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apiRouteDataProblems,
  headerExample,
  headerNameError,
  isHeaderName,
  presentedCredential,
  protectionHeader,
  routeProtection,
} from './api-route-protection'

test('a route without a value is open, whatever header it names', () => {
  assert.equal(routeProtection({}), undefined)
  assert.equal(routeProtection(undefined), undefined)
  assert.equal(routeProtection({ authHeader: 'X-Api-Key', authToken: ' ' }), undefined)
})

test('a blank header means Authorization with the Bearer scheme', () => {
  assert.deepEqual(routeProtection({ authToken: 'secret:ROUTE_KEY' }), {
    header: 'Authorization',
    scheme: 'Bearer',
    token: 'secret:ROUTE_KEY',
  })
  assert.deepEqual(protectionHeader({ authHeader: '  ' }), { header: 'Authorization', scheme: 'Bearer' })
  assert.deepEqual(protectionHeader({ authHeader: 'authorization' }), { header: 'authorization', scheme: 'Bearer' })
})

test('any other header carries the value without a scheme', () => {
  assert.deepEqual(protectionHeader({ authHeader: ' X-Api-Key ' }), { header: 'X-Api-Key', scheme: undefined })
})

test('reads the credential after the scheme, and nothing from a value in another form', () => {
  assert.equal(presentedCredential('Bearer abc', 'Bearer'), 'abc')
  assert.equal(presentedCredential('BEARER   abc', 'Bearer'), 'abc')
  assert.equal(presentedCredential('abc', 'Bearer'), undefined)
  assert.equal(presentedCredential('Basic abc', 'Bearer'), undefined)
  assert.equal(presentedCredential(null, 'Bearer'), undefined)
  assert.equal(presentedCredential('Bearer abc', undefined), 'Bearer abc')
  assert.equal(presentedCredential(null, undefined), undefined)
})

test('accepts header names a request can carry and refuses the rest', () => {
  assert.ok(isHeaderName('X-Api-Key'))
  assert.ok(isHeaderName('Authorization'))
  assert.ok(!isHeaderName('X Api Key'))
  assert.ok(!isHeaderName('X-Key:'))
  assert.ok(!isHeaderName(''))
})

test('shows what a caller sends', () => {
  assert.equal(headerExample({ header: 'Authorization', scheme: 'Bearer' }), 'Authorization: Bearer <value>')
  assert.equal(headerExample({ header: 'X-Api-Key', scheme: undefined }), 'X-Api-Key: <value>')
})

test('a protected route whose header no request can carry has an error that every request fails', () => {
  const error = headerNameError({ authHeader: 'X Api Key', authToken: 'secret:ROUTE_KEY' })
  assert.equal(error?.title, 'Header name no request can carry')
  assert.equal(error?.detail, '"X Api Key" is not a header name, so this route answers every request with 500.')
  assert.match(error?.next ?? '', /^Set Header to letters, digits and dashes/)
})

test('an open route whose header no request can carry has an error that says it is still open', () => {
  const error = headerNameError({ authHeader: 'X Api Key' })
  assert.equal(error?.title, 'Header name no request can carry')
  assert.equal(
    error?.detail,
    '"X Api Key" is not a header name. The route is open now; once Value is set, it answers every request with 500.',
  )
  assert.equal(headerNameError({ authHeader: 'X Api Key', authToken: ' ' })?.detail, error?.detail)
})

test('the route’s data validator reports a header no request can carry at authHeader, and nothing else', () => {
  const [problem, ...rest] = apiRouteDataProblems({ authHeader: 'X Api Key' })
  assert.equal(problem?.path, 'authHeader')
  assert.equal(problem?.title, 'Header name no request can carry')
  assert.deepEqual(rest, [])
  assert.deepEqual(apiRouteDataProblems({ authHeader: 'X-Api-Key', authToken: 'secret:ROUTE_KEY' }), [])
  assert.deepEqual(apiRouteDataProblems({}), [])
})

test('a header name a request can carry has no error, protected or open', () => {
  assert.equal(headerNameError({ authHeader: 'X-Api-Key', authToken: 'secret:ROUTE_KEY' }), undefined)
  assert.equal(headerNameError({ authHeader: 'X-Api-Key' }), undefined)
  assert.equal(headerNameError({ authToken: 'secret:ROUTE_KEY' }), undefined)
  assert.equal(headerNameError({ authHeader: '  ' }), undefined)
  assert.equal(headerNameError(undefined), undefined)
})
