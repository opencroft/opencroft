// Who reaches an extension's declared HTTP route, proved against a real
// database and real Better Auth sessions: a plain handler stays public, a
// session route runs only for a signed-in person and sees that person as an App
// action would, and a request that could change something is refused when a
// browser says it came from another origin. Each case plants a handler that
// records its calls, so "refused" also means "the extension's code never ran".
//
// dispatchExtensionRoute is called directly. The Nitro route in
// server/routes/api/ext/[extensionId]/http hands it every request unchanged,
// and is checked on a running server rather than here.
//
// Environment set up exactly as session-access.test.ts does it, and for the
// same reason: `@opencroft/db` opens and migrates its connection at import time.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import type { ExtensionRoute, ExtensionRouteContext } from '@opencroft/server'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-extension-routes-test-'))
process.env.OPENCROFT_DATA_DIR = join(workdir, 'data')
process.env.DB_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
)
delete process.env.DATABASE_URL
// No BETTER_AUTH_SECRET in a test process — Better Auth needs a secret
// configured before it will sign or verify a session at all.
process.env.NODE_ENV = 'development'

const { ensureAuth, getSessionUser } = await import('@opencroft/auth/server')
const { dispatchExtensionRoute } = await import('./routes')
const { directoryUserOf } = await import('@/app/_server/user-directory')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

const URL_BASE = 'http://localhost:9999/api/ext/acme.example/http/files'

// A real Better Auth session: sign up and keep the cookie the response sets.
async function signUp(email: string): Promise<{ id: string; cookie: string }> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name: `Person ${email}`, email, password: 'password123456' },
    asResponse: true,
  })
  const cookie = result.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'sign-up must return a session cookie')
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

const member = await signUp('member@example.test')

function request(options: { cookie?: string; method?: string; site?: string; origin?: string } = {}): Request {
  const headers = new Headers()
  if (options.cookie) headers.set('cookie', options.cookie)
  if (options.site) headers.set('sec-fetch-site', options.site)
  if (options.origin) headers.set('origin', options.origin)
  return new Request(URL_BASE, { method: options.method ?? 'GET', headers })
}

/** A session route that records every call its handler gets. */
function plantedSessionRoute() {
  const calls: ExtensionRouteContext[] = []
  const route: ExtensionRoute = {
    session: 'person',
    handler: (_request, context) => {
      calls.push(context)
      return new Response('served')
    },
  }
  return { route, calls }
}

test('an undeclared route is 404', async () => {
  const response = await dispatchExtensionRoute(undefined, request())
  assert.equal(response.status, 404)
})

test('a plain handler stays public: an anonymous request reaches it', async () => {
  let called = 0
  const response = await dispatchExtensionRoute(
    () => {
      called++
      return new Response('webhook')
    },
    request({ method: 'POST', site: 'cross-site' }),
  )
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'webhook')
  assert.equal(called, 1)
})

test('a session route without a session is 401 and its handler never runs', async () => {
  const { route, calls } = plantedSessionRoute()
  const response = await dispatchExtensionRoute(route, request())
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'Unauthorized' })
  assert.equal(calls.length, 0)
})

test('a session route with a cookie that names no session is 401 and its handler never runs', async () => {
  const { route, calls } = plantedSessionRoute()
  const [name] = member.cookie.split('=')
  const response = await dispatchExtensionRoute(route, request({ cookie: `${name}=not-a-session` }))
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
})

test('a signed-in request reaches the handler with the person an App action would get', async () => {
  const { route, calls } = plantedSessionRoute()
  const response = await dispatchExtensionRoute(route, request({ cookie: member.cookie }))
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'served')
  assert.equal(calls.length, 1)
  const sessionUser = await getSessionUser(request({ cookie: member.cookie }))
  assert.ok(sessionUser)
  // callAppActionFromUi binds `callerPerson` as directoryUserOf(session user),
  // so this is that person, field for field.
  assert.deepEqual(calls[0]?.person, directoryUserOf(sessionUser))
  assert.deepEqual(calls[0]?.person, { id: member.id, name: 'Person member@example.test', avatarUrl: null })
})

test('a change sent from another origin is refused before the handler, even with a session', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const { route, calls } = plantedSessionRoute()
    const response = await dispatchExtensionRoute(route, request({ cookie: member.cookie, method: 'POST', site }))
    assert.equal(response.status, 403, site)
    assert.equal(calls.length, 0, site)
  }
})

test('a change from the same origin, or from a client that is not a browser, reaches the handler', async () => {
  for (const site of ['same-origin', 'none', undefined]) {
    const { route, calls } = plantedSessionRoute()
    const response = await dispatchExtensionRoute(route, request({ cookie: member.cookie, method: 'POST', site }))
    assert.equal(response.status, 200, String(site))
    assert.equal(calls.length, 1, String(site))
  }
})

test('without Fetch Metadata, a change is refused when its Origin is another one, and served when it is this one', async () => {
  // What a browser too old to send Sec-Fetch-Site sends: Origin alone.
  for (const origin of ['https://evil.example.test', 'http://localhost:1', 'https://localhost:9999', 'null']) {
    const { route, calls } = plantedSessionRoute()
    const response = await dispatchExtensionRoute(route, request({ cookie: member.cookie, method: 'POST', origin }))
    assert.equal(response.status, 403, origin)
    assert.equal(calls.length, 0, origin)
  }
  const { route, calls } = plantedSessionRoute()
  const own = await dispatchExtensionRoute(
    route,
    request({ cookie: member.cookie, method: 'POST', origin: new URL(URL_BASE).origin }),
  )
  assert.equal(own.status, 200)
  assert.equal(calls.length, 1)
})

test('a read from another origin reaches the handler: GET is answered whoever links to it', async () => {
  const { route, calls } = plantedSessionRoute()
  const response = await dispatchExtensionRoute(route, request({ cookie: member.cookie, site: 'cross-site' }))
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
})

test('a declaration the host does not know fails closed instead of being served as public', async () => {
  let called = 0
  const handler = () => {
    called++
    return new Response('leaked')
  }
  const malformed = [
    { session: 'admin', handler },
    { session: 'Person', handler },
    { session: 'person' },
    { handler },
  ] as unknown as ExtensionRoute[]
  for (const route of malformed) {
    const response = await dispatchExtensionRoute(route, request({ cookie: member.cookie }))
    assert.equal(response.status, 500, JSON.stringify(route))
  }
  assert.equal(called, 0)
})
