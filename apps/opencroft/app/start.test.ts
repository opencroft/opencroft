// The session gate covers every server function only because it is registered
// as global function middleware here; a function's own `.middleware([...])`
// would cover that function alone. The CSRF check is the instance's request
// middleware, driven below with the context Start's handler gives it
// (`request`, `handlerType`, `next`); the HTTP answer itself is not exercised
// here.

import assert from 'node:assert/strict'
import test from 'node:test'

import { serverFnSessionGate } from '@/app/_server/server-fn-session-gate'
import { startInstance } from '@/app/start'

const APP_ORIGIN = 'http://app.example.com'
const PASSED = new Response('passed')

type RequestMiddleware = {
  options: {
    server?: (ctx: { request: Request; handlerType: string; next: () => Promise<Response> }) => Promise<unknown>
  }
}

/** Runs the instance's request middleware chain; the end of the chain answers `PASSED`. */
async function runRequestMiddleware(handlerType: 'serverFn' | 'router', headers: Record<string, string>) {
  const options = await startInstance.getOptions()
  const chain = (options.requestMiddleware ?? []) as unknown as RequestMiddleware[]
  const request = new Request(`${APP_ORIGIN}/_serverFn/some-id`, { method: 'POST', headers })
  const run = async (index: number): Promise<unknown> => {
    if (index >= chain.length) return PASSED
    const server = chain[index].options.server
    if (!server) return run(index + 1)
    return server({ request, handlerType, next: async () => (await run(index + 1)) as Response })
  }
  return run(0)
}

async function statusOf(result: unknown) {
  assert.ok(result instanceof Response, 'the middleware chain answers with a Response')
  return result === PASSED ? 'passed' : result.status
}

test('the session gate is the first function middleware of every server function', async () => {
  const options = await startInstance.getOptions()
  assert.equal(options.functionMiddleware?.[0], serverFnSessionGate)
})

test('a same-origin server-function request passes the CSRF check', async () => {
  assert.equal(await statusOf(await runRequestMiddleware('serverFn', { Origin: APP_ORIGIN })), 'passed')
  assert.equal(await statusOf(await runRequestMiddleware('serverFn', { 'Sec-Fetch-Site': 'same-origin' })), 'passed')
})

test('a server-function request from another site is refused with 403', async () => {
  assert.equal(await statusOf(await runRequestMiddleware('serverFn', { Origin: 'https://attacker.example' })), 403)
  assert.equal(await statusOf(await runRequestMiddleware('serverFn', { 'Sec-Fetch-Site': 'cross-site' })), 403)
})

test('a server-function request with no Sec-Fetch-Site, Origin or Referer is refused with 403', async () => {
  assert.equal(await statusOf(await runRequestMiddleware('serverFn', {})), 403)
})

test('page and API route requests are not CSRF-checked', async () => {
  assert.equal(await statusOf(await runRequestMiddleware('router', { 'Sec-Fetch-Site': 'cross-site' })), 'passed')
})
