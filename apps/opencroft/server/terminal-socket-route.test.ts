// The terminal WebSocket route (routes/api/ws/terminal.ts), driven through its
// own crossws hooks with a real Better Auth session and the real terminal
// socket behind it. What is proved: a message is handed to the terminal only
// once startup has finished and the peer's session has been checked, so a
// dial sent during boot reaches the Key Store rule startup registers instead
// of being refused for the lack of one, and a peer refused or gone before
// admission never reaches the terminal at all.
//
// The dial names a Key Store key, so the first thing it does is ask the
// registered access rule, before any network; the rule registered here records
// the call and refuses, which ends the dial with that refusal.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { ensureAuth, getSessionUser } from '@opencroft/auth/server'
import { registerKeyStoreAccess } from '@opencroft/terminal/server'

// Startup is held pending until the test says it has finished. Set before the
// route is imported, so nothing starts the real server (which would arm every
// scheduler and keep this process alive).
let finishStartup!: () => void
;(globalThis as { __opencroftReady?: Promise<void> }).__opencroftReady = new Promise<void>((resolve) => {
  finishStartup = resolve
})

const { default: route } = await import('./routes/api/ws/terminal')

interface FakePeer {
  request: Request
  sent: { type: string; payload: { message?: string } }[]
  closedWith: number | null
  send(data: string): void
  close(code?: number): void
}

interface Hooks {
  open(peer: FakePeer): void
  message(peer: FakePeer, message: { text(): string }): void
  close(peer: FakePeer, details: { code?: number }): void
}

// Nitro's handler answers a non-upgrade request with the hooks attached as `crossws`.
const hooks = (route as unknown as (event: unknown) => { crossws: Hooks })({}).crossws

function peer(request: Request): FakePeer {
  return {
    request,
    sent: [],
    closedWith: null,
    send(data) {
      this.sent.push(JSON.parse(data))
    },
    close(code) {
      this.closedWith = code ?? null
    },
  }
}

async function signedInRequest(email: string): Promise<Request> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name: email, email, password: 'password123456' },
    asResponse: true,
  })
  const cookie = result.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'sign-up must return a session cookie')
  return new Request('http://localhost:9999/api/ws/terminal', { headers: { cookie } })
}

function dialMessage(storeId: string): { text(): string } {
  const payload = {
    host: '127.0.0.1',
    port: 1,
    username: 'someone',
    keyPath: `${storeId}:deploy-key`,
    credentialsScope: 'server-node',
    cols: 80,
    rows: 24,
  }
  return { text: () => JSON.stringify({ type: 'connect', payload }) }
}

/** Lets pending callbacks and the session lookup for `request` run. */
async function settle(request: Request): Promise<void> {
  await getSessionUser(request)
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(condition(), `timed out waiting for ${what}`)
}

const accessChecks: [string, string | undefined][] = []

function registerRefusingRule(): void {
  registerKeyStoreAccess(async (storeId, scope) => {
    accessChecks.push([storeId, scope])
    throw new Error(`store ${storeId} refused by the test rule`)
  })
}

test('a dial sent during startup waits for it and is checked by the rule startup registers', async () => {
  const request = await signedInRequest('booting@example.test')
  const terminal = peer(request)

  hooks.open(terminal)
  hooks.message(terminal, dialMessage('store-booting'))
  await settle(request)

  assert.equal(terminal.sent.length, 0, 'nothing answered the dial while startup runs')
  assert.equal(terminal.closedWith, null)

  // What startup does: register the rule, then finish.
  registerRefusingRule()
  finishStartup()

  await until(() => terminal.sent.length > 0, 'the dial to be answered')
  assert.deepEqual(accessChecks, [['store-booting', 'server-node']])
  assert.equal(terminal.sent.length, 1)
  assert.equal(terminal.sent[0]?.type, 'error')
  assert.match(terminal.sent[0]?.payload.message ?? '', /store store-booting refused by the test rule/)
  assert.doesNotMatch(terminal.sent[0]?.payload.message ?? '', /has not said which nodes may use which stores/)
})

test('a message from a peer with no session never reaches the terminal', async () => {
  const request = new Request('http://localhost:9999/api/ws/terminal')
  const anonymous = peer(request)
  const checksBefore = accessChecks.length

  hooks.open(anonymous)
  hooks.message(anonymous, dialMessage('store-anonymous'))
  await until(() => anonymous.closedWith !== null, 'the anonymous peer to be closed')
  await settle(request)

  assert.equal(anonymous.closedWith, 4401)
  assert.equal(accessChecks.length, checksBefore, 'the dial never ran')
  assert.deepEqual(anonymous.sent, [])
})

test('a message held for a peer that closes before admission is dropped', async () => {
  const request = await signedInRequest('leaving@example.test')
  const leaving = peer(request)
  const checksBefore = accessChecks.length

  hooks.open(leaving)
  hooks.message(leaving, dialMessage('store-leaving'))
  hooks.close(leaving, { code: 1001 })
  await settle(request)

  assert.equal(accessChecks.length, checksBefore, 'the dial never ran')
  assert.deepEqual(leaving.sent, [])
})
