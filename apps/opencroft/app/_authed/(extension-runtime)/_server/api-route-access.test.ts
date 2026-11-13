// Exercises the access check an API Route's request passes before its handler
// runs. Fixture values are placeholders; no real credential is used here.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { NodeError } from '@opencroft/core'

import { PROTECTION_ERROR_SOURCE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/api-route-protection'
import { NODE_ERRORS_KEY } from '@/app/_authed/(extension-runtime)/_node-errors'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { secrets } from '@/server/secrets'
import { checkRouteAccess, type ReportErrors, type ResolveValue } from './api-route-access'

const VALUE = 'placeholder-route-value'

// Stands in for the Secrets Store: `secret:ROUTE_KEY` resolves, typed text is itself.
const resolve: ResolveValue = async (stored) => {
  if (stored === 'secret:ROUTE_KEY') {
    return VALUE
  }
  if (stored.startsWith('secret:')) {
    throw new Error(`Secret "${stored.slice(7)}" not found in any Secrets Store`)
  }
  return stored
}

function silenced<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error
  console.error = () => {}
  return run().finally(() => {
    console.error = original
  })
}

// Stands in for `graph.setNodeErrors`: keeps every report the check makes.
function recorded(): { report: ReportErrors; calls: { nodeId: string; errors: NodeError[] }[] } {
  const calls: { nodeId: string; errors: NodeError[] }[] = []
  return {
    calls,
    report: async (nodeId, errors) => {
      calls.push({ nodeId, errors })
    },
  }
}

test('an open route lets every request through with all of its headers', async () => {
  const access = await checkRouteAccess('route-1', { authToken: '' }, new Headers({ 'x-trace': 'abc' }), { resolve })
  assert.deepEqual(access, { allowed: true, headers: { 'x-trace': 'abc' } })
})

test('a route with a whitespace-only value is open', async () => {
  const access = await checkRouteAccess('route-1', { authToken: '   ' }, new Headers(), { resolve })
  assert.equal(access.allowed, true)
})

test('a Bearer credential matching the secret is let through, and the handler does not see it', async () => {
  const headers = new Headers({ authorization: `Bearer ${VALUE}`, 'x-trace': 'abc' })
  const access = await checkRouteAccess('route-1', { authToken: 'secret:ROUTE_KEY' }, headers, { resolve })
  assert.deepEqual(access, { allowed: true, headers: { 'x-trace': 'abc' } })
})

test('the Bearer scheme name is matched without regard to case', async () => {
  const headers = new Headers({ authorization: `bearer ${VALUE}` })
  const access = await checkRouteAccess('route-1', { authToken: 'secret:ROUTE_KEY' }, headers, { resolve })
  assert.equal(access.allowed, true)
})

for (const [label, value] of [
  ['a missing header', undefined],
  ['a wrong value', 'Bearer placeholder-wrong-value'],
  ['the value without the Bearer scheme', VALUE],
  ['another scheme', `Basic ${VALUE}`],
  ['a prefix of the value', `Bearer ${VALUE.slice(0, -1)}`],
  ['the value with more after it', `Bearer ${VALUE}x`],
] as const) {
  test(`${label} gets 401 that names neither the header nor the value`, async () => {
    const headers = new Headers(value === undefined ? {} : { authorization: value })
    const access = await checkRouteAccess('route-1', { authToken: 'secret:ROUTE_KEY' }, headers, { resolve })
    assert.equal(access.allowed, false)
    if (access.allowed) {
      return
    }
    assert.equal(access.response.status, 401)
    assert.equal(access.response.headers.get('www-authenticate'), 'Bearer')
    const body = await access.response.text()
    assert.deepEqual(JSON.parse(body), { error: 'Unauthorized' })
    assert.ok(!body.includes(VALUE))
  })
}

test('a custom header carries the value as is, and is the header the handler does not see', async () => {
  const data = { authHeader: 'X-Api-Key', authToken: 'secret:ROUTE_KEY' }
  const allowed = await checkRouteAccess('route-1', data, new Headers({ 'x-api-key': VALUE, authorization: 'x' }), {
    resolve,
  })
  assert.deepEqual(allowed, { allowed: true, headers: { authorization: 'x' } })

  const bearer = await checkRouteAccess('route-1', data, new Headers({ 'x-api-key': `Bearer ${VALUE}` }), { resolve })
  assert.equal(bearer.allowed, false)
  if (!bearer.allowed) {
    assert.equal(bearer.response.status, 401)
    assert.equal(bearer.response.headers.get('www-authenticate'), null)
  }

  const onAuthorization = await checkRouteAccess('route-1', data, new Headers({ authorization: `Bearer ${VALUE}` }), {
    resolve,
  })
  assert.equal(onAuthorization.allowed, false)
})

test('a typed value protects the route the same way', async () => {
  const data = { authToken: 'placeholder-typed-value' }
  const allowed = await checkRouteAccess(
    'route-1',
    data,
    new Headers({ authorization: 'Bearer placeholder-typed-value' }),
    { resolve },
  )
  assert.equal(allowed.allowed, true)
  const refused = await checkRouteAccess('route-1', data, new Headers({ authorization: `Bearer ${VALUE}` }), {
    resolve,
  })
  assert.equal(refused.allowed, false)
})

for (const [label, data] of [
  ['a secret no store holds', { authToken: 'secret:NO_SUCH_KEY' }],
  ['a header name no request can carry', { authHeader: 'X Api Key', authToken: 'secret:ROUTE_KEY' }],
  ['a value that resolves to empty', { authToken: 'secret:EMPTY' }],
] as const) {
  test(`${label} keeps the route shut with 500, even for a request carrying the value`, async () => {
    const withEmpty: ResolveValue = async (stored) => (stored === 'secret:EMPTY' ? '' : resolve(stored))
    const headers = new Headers({ authorization: `Bearer ${VALUE}` })
    const access = await silenced(() =>
      checkRouteAccess('route-1', data, headers, { resolve: withEmpty, report: recorded().report }),
    )
    assert.equal(access.allowed, false)
    if (!access.allowed) {
      assert.equal(access.response.status, 500)
      assert.ok(!(await access.response.text()).includes(VALUE))
    }
  })
}

/** A fresh space whose graph holds a Secrets Store and a route node; answers both ids. */
async function routeWithStore(): Promise<{ routeId: string; storeId: string }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `route-access-${crypto.randomUUID().slice(0, 8)}`
  const routeId = `route-${slug}`
  const storeId = `store-${slug}`
  await registry.create(slug, slug, {
    nodes: [
      { id: storeId, type: 'builtin.core.core-secrets-store', position: { x: 0, y: 0 }, data: { secretKeys: [] } },
      { id: routeId, type: 'builtin.core.api-route', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [],
  })
  return { routeId, storeId }
}

function bearer(value: string): Headers {
  return new Headers({ authorization: `Bearer ${value}` })
}

test('the value is resolved from the Secrets Store on every request, so a rotation takes effect at once', async () => {
  const { routeId, storeId } = await routeWithStore()
  const key = `ROUTE_ACCESS_${crypto.randomUUID().replaceAll('-', '_')}`
  const data = { authToken: `secret:${key}` }
  const { report } = recorded()
  await secrets.set(storeId, key, 'placeholder-first-value')
  const first = await checkRouteAccess(routeId, data, bearer('placeholder-first-value'), { report })
  assert.equal(first.allowed, true)

  await secrets.set(storeId, key, 'placeholder-second-value')
  const stale = await checkRouteAccess(routeId, data, bearer('placeholder-first-value'), { report })
  assert.equal(stale.allowed, false)
  const fresh = await checkRouteAccess(routeId, data, bearer('placeholder-second-value'), { report })
  assert.equal(fresh.allowed, true)
})

test('a name two graphs both hold opens each route with its own graph’s value only', async () => {
  const key = `ROUTE_CLASH_${crypto.randomUUID().replaceAll('-', '_')}`
  const older = await routeWithStore()
  const newer = await routeWithStore()
  await secrets.set(older.storeId, key, 'placeholder-older-value')
  await secrets.set(newer.storeId, key, 'placeholder-newer-value')
  const data = { authToken: `secret:${key}` }
  const { report } = recorded()

  const byOther = await checkRouteAccess(newer.routeId, data, bearer('placeholder-older-value'), { report })
  assert.equal(byOther.allowed, false, 'the other graph’s value does not open the route')
  const byOwn = await checkRouteAccess(newer.routeId, data, bearer('placeholder-newer-value'), { report })
  assert.equal(byOwn.allowed, true)

  await secrets.set(newer.storeId, key, 'placeholder-rotated-value')
  const rotated = await checkRouteAccess(newer.routeId, data, bearer('placeholder-rotated-value'), { report })
  assert.equal(rotated.allowed, true, 'rotating the route’s own secret takes effect')
})

test('a name only another space holds keeps the route shut, and the error names the route’s graph', async () => {
  const key = `ROUTE_ELSEWHERE_${crypto.randomUUID().replaceAll('-', '_')}`
  const other = await routeWithStore()
  await secrets.set(other.storeId, key, 'placeholder-other-value')
  const asking = await routeWithStore()
  const { report, calls } = recorded()

  const access = await silenced(() =>
    checkRouteAccess(asking.routeId, { authToken: `secret:${key}` }, bearer('placeholder-other-value'), { report }),
  )
  assert.equal(access.allowed, false)
  if (!access.allowed) {
    assert.equal(access.response.status, 500)
  }
  const reported = JSON.stringify(calls.at(-1)?.errors ?? [])
  assert.ok(reported.includes(key) && reported.includes('on graph route-access-'), reported)
})

test('a secret no store holds is reported as the node error, naming the route and the secret', async () => {
  const { report, calls } = recorded()
  const data = { path: '/hooks/build', authToken: 'secret:NO_SUCH_KEY' }
  const headers = new Headers({ authorization: `Bearer ${VALUE}` })
  const access = await silenced(() => checkRouteAccess('route-1', data, headers, { resolve, report }))
  assert.equal(access.allowed, false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].nodeId, 'route-1')
  assert.equal(calls[0].errors.length, 1)
  const [error] = calls[0].errors
  assert.equal(error.title, 'Protecting value not available')
  assert.match(error.detail ?? '', /\/hooks\/build gets 500: Secret "NO_SUCH_KEY" not found in any Secrets Store/)
  assert.match(error.next ?? '', /Add NO_SUCH_KEY to a Secrets Store/)
  assert.ok(!JSON.stringify(error).includes(VALUE))
})

test('an empty secret is reported as the node error too', async () => {
  const { report, calls } = recorded()
  const withEmpty: ResolveValue = async () => ''
  const data = { authToken: 'secret:EMPTY' }
  await silenced(() => checkRouteAccess('route-1', data, new Headers(), { resolve: withEmpty, report }))
  assert.equal(calls.length, 1)
  assert.match(calls[0].errors[0]?.detail ?? '', /the required value is empty/)
})

test('a request that resolves the value clears the error the check reported, whatever the caller sent', async () => {
  const data = {
    authToken: 'secret:ROUTE_KEY',
    [NODE_ERRORS_KEY]: [{ source: PROTECTION_ERROR_SOURCE, title: 'Protecting value not available' }],
  }
  for (const headers of [new Headers({ authorization: `Bearer ${VALUE}` }), new Headers()]) {
    const { report, calls } = recorded()
    await checkRouteAccess('route-1', data, headers, { resolve, report })
    assert.deepEqual(calls, [{ nodeId: 'route-1', errors: [] }])
  }
})

test('a route made open clears the error the check reported', async () => {
  const { report, calls } = recorded()
  const data = {
    authToken: '',
    [NODE_ERRORS_KEY]: [{ source: PROTECTION_ERROR_SOURCE, title: 'Protecting value not available' }],
  }
  const access = await checkRouteAccess('route-1', data, new Headers(), { resolve, report })
  assert.equal(access.allowed, true)
  assert.deepEqual(calls, [{ nodeId: 'route-1', errors: [] }])
})

test('a request whose answer matches the stored errors reports nothing', async () => {
  const missing = { path: '/hooks/build', authToken: 'secret:NO_SUCH_KEY' }
  const first = recorded()
  await silenced(() => checkRouteAccess('route-1', missing, new Headers(), { resolve, report: first.report }))
  const stored = {
    ...missing,
    [NODE_ERRORS_KEY]: first.calls[0].errors.map((e) => ({ source: PROTECTION_ERROR_SOURCE, ...e })),
  }

  const again = recorded()
  await silenced(() => checkRouteAccess('route-1', stored, new Headers(), { resolve, report: again.report }))
  assert.equal(again.calls.length, 0)

  const healthy = recorded()
  await checkRouteAccess('route-1', { authToken: 'secret:ROUTE_KEY' }, new Headers(), {
    resolve,
    report: healthy.report,
  })
  await checkRouteAccess('route-1', { authToken: '' }, new Headers(), { resolve, report: healthy.report })
  assert.equal(healthy.calls.length, 0)
})

test('the errors other sources reported are left to them', async () => {
  const { report, calls } = recorded()
  const data = { authToken: 'secret:ROUTE_KEY', [NODE_ERRORS_KEY]: [{ source: 'action', title: 'Run failed' }] }
  await checkRouteAccess('route-1', data, new Headers(), { resolve, report })
  assert.equal(calls.length, 0)
})

test('a header name no request can carry is left to the canvas, not reported by the request', async () => {
  const { report, calls } = recorded()
  const data = { authHeader: 'X Api Key', authToken: 'secret:ROUTE_KEY' }
  await silenced(() => checkRouteAccess('route-1', data, new Headers(), { resolve, report }))
  assert.equal(calls.length, 0)
})

test('a report that fails does not change the answer', async () => {
  const report: ReportErrors = async () => {
    throw new Error('graph write failed')
  }
  const missing = await silenced(() =>
    checkRouteAccess('route-1', { authToken: 'secret:NO_SUCH_KEY' }, new Headers(), { resolve, report }),
  )
  assert.equal(missing.allowed, false)
  if (!missing.allowed) {
    assert.equal(missing.response.status, 500)
  }
  const data = {
    authToken: 'secret:ROUTE_KEY',
    [NODE_ERRORS_KEY]: [{ source: PROTECTION_ERROR_SOURCE, title: 'Protecting value not available' }],
  }
  const allowed = await silenced(() =>
    checkRouteAccess('route-1', data, new Headers({ authorization: `Bearer ${VALUE}` }), { resolve, report }),
  )
  assert.equal(allowed.allowed, true)
})
