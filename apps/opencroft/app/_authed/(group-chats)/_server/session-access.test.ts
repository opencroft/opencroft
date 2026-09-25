// Who reaches an agent session through the browser's ACP entry points, proved
// against a real database, real Better Auth sessions and real engine sessions:
// a member of the group chat whose thread owns the session gets through, a
// signed-in non-member and an anonymous caller do not, and a key or id that
// names nothing is refused exactly as a chat the caller is not in is.
//
// Three layers, each asserted where it can actually be driven:
//
//   - model.ts's requireSessionKeyMember / listMemberSessionKeys and
//     session-access.ts's requireSessionMember, called directly;
//   - the two routes: /api/acp/stream through its handler,
//     `Route.options.server.handlers.GET`, the way -mcp-auth.test.ts calls the
//     MCP route; /api/acp/attachments/<id> through attachmentResponse, the
//     function its Nitro route hands every request to (that the route reaches
//     it is attachment-routing.test.ts's to prove);
//   - the server-function gates (requireSessionAccess, requireSessionKeyAccess,
//     requireMemberSessionKeys), run inside `requestHandler` from
//     @tanstack/react-start/server, which is what installs the request that
//     their `getRequest()` reads. The `createServerFn` wrappers in acp.ts are
//     NOT called here: nothing in this repo invokes a compiled server function
//     in a test, so what is proved for them is the gate each one awaits.
//
// Environment set up exactly as model.test.ts does it, and for the same
// reason: `@opencroft/db` opens and migrates its connection at import time.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

// None of these opens a database connection, so importing them statically
// cannot make `@opencroft/db` connect before PGLITE_PATH is in place.
import { requestHandler } from '@tanstack/react-start/server'
import { connectionKey } from 'agent-client/agent-client'
import type { AgentConnection } from 'agent-client/connection'
import type { AgentSelection } from 'agent-client/types'
import { eq, inArray } from 'drizzle-orm'

import { slug } from '@/app/_authed/(server)/_server/types'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-session-access-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
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

const { db, space, groupChatMember, groupChatThread, groupChatThreadAlias } = await import('@opencroft/db')
const model = await import('./model')
const access = await import('./session-access')
const sessionStore = await import('@/app/_authed/(agent)/_server/acp-session-store')
const { agentClient } = await import('@/app/_authed/(agent)/_server/agent-client-instance')
const { stopLocalSessionProcessImpl } = await import('@/app/_authed/(agent)/_server/acp-impl')
const { saveAttachment } = await import('@/app/_authed/(agent)/_server/attachment-store')
const { ensureAuth } = await import('@opencroft/auth/server')
const { Route: StreamRoute } = await import('@/app/_authed/(agent)/api/acp.stream')
const { attachmentResponse } = await import('@/app/_authed/(agent)/_server/attachment-response')

// attachmentResponse waits for server start before its lookup. Starting the real
// server here would arm every scheduler and keep this process alive, so the
// once-only handle ensureServerStarted memoises on is set to "already started".
;(globalThis as { __opencroftReady?: Promise<void> }).__opencroftReady = Promise.resolve()

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

// One agent with a full provider/adapter/model triple, so ensureLocalSessionImpl
// can build a real AgentSelection for it and open a session against the mock
// connection seeded below.
await db.insert(space).values({
  slug: 'test-space',
  name: 'Test Space',
  data: JSON.stringify({
    nodes: [
      {
        id: 'agent-session',
        type: 'agent',
        data: { name: 'Agent Session', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
    ],
    edges: [],
  }),
})

// The same seam model.test.ts uses: a connection registered under the spawn
// config ensureLocalSessionImpl derives for this node, so the engine reuses it
// instead of spawning a real agent process.
{
  const connection = {
    newSession: async () => ({ sessionId: `test-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', slug('Agent Session')),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
}

interface TestUser {
  id: string
  cookie: string
}

// A real Better Auth session: sign up, keep the cookie the sign-up response
// sets, and send it on later requests — what getSessionUser authenticates.
async function makeUser(email: string): Promise<TestUser> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name: email, email, password: 'password123456' },
    asResponse: true,
  })
  const setCookie = result.headers.get('set-cookie')
  assert.ok(setCookie, 'sign-up must return a session cookie')
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie, 'the session cookie must be parseable')
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

function reqAs(u: TestUser, url = 'http://localhost:9999/'): Request {
  return new Request(url, { headers: { cookie: u.cookie } })
}

function reqAnonymous(url = 'http://localhost:9999/'): Request {
  return new Request(url)
}

/** The refusal a call produces, so two of them can be compared field by field. */
async function captureRefusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof model.GroupChatAccessError, 'expected a group-chat refusal')
    return { code: error.code, message: error.message }
  }
  throw new Error('expected the call to be refused, but it resolved')
}

const NOT_AVAILABLE = { code: 'not-found', message: 'Not available' }
const SIGN_IN = { code: 'unauthenticated', message: 'Sign in to use group chats' }
const UNKNOWN_KEY = 'group-chat.no-such-chat.agent-session.no-such-thread'
const UNKNOWN_ID = 'no-such-session-id'

// ── Fixture ─────────────────────────────────────────────────────────────
//
// `member` is in chat A and not in chat B; `outsider` owns chat B and is not in
// chat A. Every thread is started through model.startThread with an empty
// first message — the composer's "start without sending" path, which mints the
// thread and opens its session in the engine.

const member = await makeUser('session-access-member@example.test')
const outsider = await makeUser('session-access-outsider@example.test')

const chatA = await model.createGroupChat(reqAs(member), 'session access chat a')
await model.addMember(reqAs(member), chatA.id, { kind: 'agent', agentNodeId: 'agent-session' })
const chatB = await model.createGroupChat(reqAs(outsider), 'session access chat b')
await model.addMember(reqAs(outsider), chatB.id, { kind: 'agent', agentNodeId: 'agent-session' })

// A live session: the engine holds it under the thread's key.
const live = await model.startThread(reqAs(member), chatA.id, 'agent-session', '')
const liveKey = live.thread.sessionKey
const liveId = live.sessionId

// A second thread in the member's own chat, so the attachment 404 case can name
// a key the member may reach that simply does not own the id.
const sibling = await model.startThread(reqAs(member), chatA.id, 'agent-session', '')
const siblingKey = sibling.thread.sessionKey

// The other chat's thread, for listMemberSessionKeys.
const foreign = await model.startThread(reqAs(outsider), chatB.id, 'agent-session', '')
const foreignKey = foreign.thread.sessionKey

async function chatKeys(groupChatId: string): Promise<string[]> {
  const rows = await db
    .select({ sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .where(eq(groupChatThread.groupChatId, groupChatId))
  return rows.map((row) => row.sessionKey).sort()
}

test('fixture: the live session is held by the engine under its thread key', () => {
  assert.equal(agentClient.listSessions().find((session) => session.id === liveId)?.sessionKey, liveKey)
  assert.notEqual(liveKey, foreignKey)
})

// ── requireSessionKeyMember / requireSessionMember ──────────────────────

test('requireSessionKeyMember returns the key and the thread agent for a member', async () => {
  assert.deepEqual(await model.requireSessionKeyMember(reqAs(member), liveKey), {
    sessionKey: liveKey,
    agentNodeId: 'agent-session',
  })
})

test('requireSessionMember returns the thread key of a live session id for a member', async () => {
  assert.equal(await access.requireSessionMember(reqAs(member), liveId), liveKey)
})

test('a signed-in non-member is refused not-found by key and by session id', async () => {
  assert.deepEqual(await captureRefusal(() => model.requireSessionKeyMember(reqAs(outsider), liveKey)), NOT_AVAILABLE)
  assert.deepEqual(await captureRefusal(() => access.requireSessionMember(reqAs(outsider), liveId)), NOT_AVAILABLE)
  // Control: the same key and id pass for the member.
  assert.equal((await model.requireSessionKeyMember(reqAs(member), liveKey)).sessionKey, liveKey)
  assert.equal(await access.requireSessionMember(reqAs(member), liveId), liveKey)
})

test('an anonymous caller is refused unauthenticated by key and by session id', async () => {
  assert.deepEqual(await captureRefusal(() => model.requireSessionKeyMember(reqAnonymous(), liveKey)), SIGN_IN)
  assert.deepEqual(await captureRefusal(() => access.requireSessionMember(reqAnonymous(), liveId)), SIGN_IN)
  // Control: the same key and id pass for the member.
  assert.equal((await model.requireSessionKeyMember(reqAs(member), liveKey)).sessionKey, liveKey)
  assert.equal(await access.requireSessionMember(reqAs(member), liveId), liveKey)
})

test('an unknown key and an unknown session id get exactly the non-member refusal', async () => {
  const nonMember = await captureRefusal(() => model.requireSessionKeyMember(reqAs(outsider), liveKey))
  assert.deepEqual(nonMember, NOT_AVAILABLE)
  assert.deepEqual(await captureRefusal(() => model.requireSessionKeyMember(reqAs(member), UNKNOWN_KEY)), nonMember)
  assert.deepEqual(await captureRefusal(() => access.requireSessionMember(reqAs(member), UNKNOWN_ID)), nonMember)
  // Control: the member's real key and id pass.
  assert.equal((await model.requireSessionKeyMember(reqAs(member), liveKey)).sessionKey, liveKey)
  assert.equal(await access.requireSessionMember(reqAs(member), liveId), liveKey)
})

// No existence oracle for anonymous callers: sign-in is checked before the key
// or id is looked at.
test('an anonymous caller naming an unknown key or id is refused unauthenticated, not not-found', async () => {
  assert.deepEqual(await captureRefusal(() => model.requireSessionKeyMember(reqAnonymous(), UNKNOWN_KEY)), SIGN_IN)
  assert.deepEqual(await captureRefusal(() => access.requireSessionMember(reqAnonymous(), UNKNOWN_ID)), SIGN_IN)
  // Control: the same key and id, signed in, are refused not-found — they really
  // name nothing.
  assert.deepEqual(await captureRefusal(() => model.requireSessionKeyMember(reqAs(member), UNKNOWN_KEY)), NOT_AVAILABLE)
  assert.deepEqual(await captureRefusal(() => access.requireSessionMember(reqAs(member), UNKNOWN_ID)), NOT_AVAILABLE)
})

test('a key retired by renameThread still passes requireSessionKeyMember for a member, not for a non-member', async () => {
  // A titled thread's key ends in the title's slug, so a rename moves the key
  // and records the old one as an alias.
  const named = await model.startThread(reqAs(member), chatA.id, 'agent-session', '', { title: 'Before rename' })
  const retiredKey = named.thread.sessionKey
  await model.renameThread(reqAs(member), named.thread.id, 'After rename')

  const [current] = await db
    .select({ sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, named.thread.id))
  assert.ok(current)
  assert.notEqual(current.sessionKey, retiredKey, 'the rename must have moved the key')
  const aliases = await db
    .select({ sessionKey: groupChatThreadAlias.sessionKey })
    .from(groupChatThreadAlias)
    .where(eq(groupChatThreadAlias.threadId, named.thread.id))
  assert.deepEqual(aliases, [{ sessionKey: retiredKey }], 'the old key must now be an alias row of the thread')

  assert.deepEqual(await model.requireSessionKeyMember(reqAs(member), retiredKey), {
    sessionKey: retiredKey,
    agentNodeId: 'agent-session',
  })
  assert.deepEqual(
    await captureRefusal(() => model.requireSessionKeyMember(reqAs(outsider), retiredKey)),
    NOT_AVAILABLE,
  )
})

// A process stop (stopLocalSessionProcessImpl, the "stop process" button) drops
// the engine's session and keeps the durable pointer, so the id is then known
// only to the pointer.
const unloaded = await model.startThread(reqAs(member), chatA.id, 'agent-session', '')
const unloadedKey = unloaded.thread.sessionKey
const unloadedId = unloaded.sessionId
await stopLocalSessionProcessImpl(unloadedKey)

test('a session id known only to the persisted pointer resolves to its key for a member, not a non-member', async () => {
  assert.equal(
    agentClient.listSessions().some((session) => session.id === unloadedId),
    false,
    'the engine must no longer hold the session',
  )
  assert.deepEqual(await sessionStore.readPersistedSession(unloadedKey), { id: unloadedId, prompted: false })

  assert.equal(await access.requireSessionMember(reqAs(member), unloadedId), unloadedKey)
  assert.deepEqual(await captureRefusal(() => access.requireSessionMember(reqAs(outsider), unloadedId)), NOT_AVAILABLE)
})

// ── listMemberSessionKeys ───────────────────────────────────────────────

test('listMemberSessionKeys returns exactly the keys of the caller’s own chats', async () => {
  const mine = await model.listMemberSessionKeys(reqAs(member))
  assert.deepEqual([...mine].sort(), await chatKeys(chatA.id))
  assert.equal(mine.has(foreignKey), false)
  // Control: the other chat's member gets that chat's keys, and not these.
  const theirs = await model.listMemberSessionKeys(reqAs(outsider))
  assert.deepEqual([...theirs].sort(), await chatKeys(chatB.id))
  assert.deepEqual([...theirs].sort(), [foreignKey])
  // Sanity on the fixture: chat A really has threads, and chat B's only member
  // row for a person is the outsider.
  assert.ok((await chatKeys(chatA.id)).length >= 3)
  const chatBPeople = await db
    .select({ userId: groupChatMember.userId })
    .from(groupChatMember)
    .where(inArray(groupChatMember.groupChatId, [chatB.id]))
  assert.deepEqual(
    chatBPeople.map((row) => row.userId).filter((id) => id !== null),
    [outsider.id],
  )
})

test('listMemberSessionKeys refuses an anonymous caller unauthenticated', async () => {
  assert.deepEqual(await captureRefusal(() => model.listMemberSessionKeys(reqAnonymous())), SIGN_IN)
})

// ── Route handlers ──────────────────────────────────────────────────────

type Handler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>

function handler(route: { options: { server?: { handlers?: unknown } } }, method: string): Handler {
  const handlers = route.options.server?.handlers as Record<string, Handler> | undefined
  const found = handlers?.[method]
  assert.ok(found, `the route must have a ${method} handler`)
  return found
}

const streamGet = handler(StreamRoute, 'GET')

// A JSON refusal as the route builds it with Response.json: status, type and
// the exact bytes of the body.
function jsonAnswer(status: number, body: string): { status: number; contentType: string; body: Buffer } {
  return { status, contentType: 'application/json', body: Buffer.from(body) }
}

const FORBIDDEN = jsonAnswer(403, '{"error":"Forbidden"}')
const UNAUTHORIZED = jsonAnswer(401, '{"error":"Unauthorized"}')

// Status, type and body bytes of an answer that is expected to be complete. An
// open event stream is released and failed at once instead of read: its body
// never ends, so reading it would hang the run rather than fail the test.
async function answerOf(response: Response): Promise<{ status: number; contentType: string | null; body: Buffer }> {
  if (response.headers.get('content-type') === 'text/event-stream' && response.status === 200) {
    await response.body?.cancel()
    assert.fail('expected a complete answer, got an open event stream')
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body: Buffer.from(await response.arrayBuffer()),
  }
}

function streamUrl(sessionId: string): string {
  return `http://localhost:9999/api/acp/stream?sessionId=${encodeURIComponent(sessionId)}`
}

async function stream(as: TestUser | null, sessionId: string): Promise<Response> {
  const url = streamUrl(sessionId)
  return streamGet({ request: as ? reqAs(as, url) : reqAnonymous(url), params: {} })
}

/** A member's pass on the stream: the status and type, then the body released so nothing stays subscribed. */
async function assertStreamOpens(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type')
  await response.body?.cancel()
  assert.equal(response.status, 200)
  assert.equal(contentType, 'text/event-stream')
}

test('stream: a member gets 200 text/event-stream for a live session', async () => {
  await assertStreamOpens(await stream(member, liveId))
})

test('stream: a signed-in non-member gets 403 {"error":"Forbidden"}', async () => {
  assert.deepEqual(await answerOf(await stream(outsider, liveId)), FORBIDDEN)
  await assertStreamOpens(await stream(member, liveId))
})

test('stream: an anonymous caller gets 401 {"error":"Unauthorized"}', async () => {
  assert.deepEqual(await answerOf(await stream(null, liveId)), UNAUTHORIZED)
  await assertStreamOpens(await stream(member, liveId))
})

test('stream: an unknown session id gets a 403 byte-identical to the non-member 403', async () => {
  const nonMember = await answerOf(await stream(outsider, liveId))
  assert.deepEqual(nonMember, FORBIDDEN)
  assert.deepEqual(await answerOf(await stream(member, UNKNOWN_ID)), nonMember)
  assert.deepEqual(await answerOf(await stream(outsider, UNKNOWN_ID)), nonMember)
  await assertStreamOpens(await stream(member, liveId))
})

// The engine holds no such session, so the stream answers with the gone frame
// and closes — which is what lets its body be asserted in full.
test('stream: a member gets 200 and exactly the gone frame for a session known only to the persisted pointer', async () => {
  const response = await stream(member, unloadedId)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(await response.text(), 'data: {"kind":"session_gone"}\n\n')
  assert.deepEqual(await answerOf(await stream(outsider, unloadedId)), FORBIDDEN)
})

// The PNG signature followed by bytes a text round trip would mangle (0xfe,
// 0xff). saveAttachment checks the declared type and the size, not the content,
// so this is stored as given and the route must hand back exactly these bytes.
const PICTURE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xfe, 0xff])
const SIBLING_BYTES = Buffer.from([1, 2, 3, 4])
const picture = await saveAttachment({
  sessionKey: liveKey,
  name: 'picture.png',
  mimeType: 'image/png',
  data: PICTURE_BYTES.toString('base64'),
})
const siblingPicture = await saveAttachment({
  sessionKey: siblingKey,
  name: 'sibling.png',
  mimeType: 'image/png',
  data: SIBLING_BYTES.toString('base64'),
})

async function attachment(as: TestUser | null, key: string, id: string): Promise<Response> {
  const url = `http://localhost:9999/api/acp/attachments/${id}?key=${encodeURIComponent(key)}`
  return attachmentResponse(as ? reqAs(as, url) : reqAnonymous(url), id)
}

function picturePng(bytes: Buffer): { status: number; contentType: string; body: Buffer } {
  return { status: 200, contentType: 'image/png', body: bytes }
}

test('attachments: a member gets 200 with the stored bytes', async () => {
  assert.deepEqual(await answerOf(await attachment(member, liveKey, picture.id)), picturePng(PICTURE_BYTES))
})

test('attachments: a signed-in non-member gets 403 {"error":"Forbidden"}', async () => {
  assert.deepEqual(await answerOf(await attachment(outsider, liveKey, picture.id)), FORBIDDEN)
  assert.deepEqual(await answerOf(await attachment(member, liveKey, picture.id)), picturePng(PICTURE_BYTES))
})

test('attachments: an anonymous caller gets 401 {"error":"Unauthorized"}', async () => {
  assert.deepEqual(await answerOf(await attachment(null, liveKey, picture.id)), UNAUTHORIZED)
  assert.deepEqual(await answerOf(await attachment(member, liveKey, picture.id)), picturePng(PICTURE_BYTES))
})

test('attachments: an unknown key gets a 403 byte-identical to the non-member 403', async () => {
  const nonMember = await answerOf(await attachment(outsider, liveKey, picture.id))
  assert.deepEqual(nonMember, FORBIDDEN)
  assert.deepEqual(await answerOf(await attachment(member, UNKNOWN_KEY, picture.id)), nonMember)
  assert.deepEqual(await answerOf(await attachment(member, liveKey, picture.id)), picturePng(PICTURE_BYTES))
})

test('attachments: a member naming an id with a key of theirs that does not own it gets 404', async () => {
  assert.deepEqual(
    await answerOf(await attachment(member, liveKey, siblingPicture.id)),
    jsonAnswer(404, '{"error":"Attachment not found"}'),
  )
  // Control: the same id under the key that owns it is served.
  assert.deepEqual(await answerOf(await attachment(member, siblingKey, siblingPicture.id)), picturePng(SIBLING_BYTES))
})

// ── Server-function gates ───────────────────────────────────────────────
//
// Run inside `requestHandler`, which puts the request where `getRequest()`
// finds it. The outcome is captured inside rather than read off the Response
// requestHandler builds, so what is asserted is the gate's own return value or
// its own thrown Response.

type Outcome<T> = { resolved: T } | { thrown: unknown }

async function inRequest<T>(request: Request, run: () => Promise<T>): Promise<Outcome<T>> {
  let outcome: Outcome<T> | undefined
  await requestHandler(async () => {
    try {
      outcome = { resolved: await run() }
    } catch (error) {
      outcome = { thrown: error }
    }
    return new Response(null, { status: 204 })
  })(request, {})
  assert.ok(outcome, 'the gate must have run inside the request')
  return outcome
}

async function thrownAnswer<T>(
  outcome: Outcome<T>,
): Promise<{ status: number; contentType: string | null; body: Buffer }> {
  assert.ok('thrown' in outcome, 'expected the gate to refuse')
  assert.ok(outcome.thrown instanceof Response, 'the refusal must be a thrown Response')
  return answerOf(outcome.thrown)
}

test('requireSessionAccess: a member resolves to the session key', async () => {
  assert.deepEqual(await inRequest(reqAs(member), () => access.requireSessionAccess(liveId)), { resolved: liveKey })
})

test('requireSessionAccess: a non-member and an unknown id throw 403, an anonymous caller throws 401', async () => {
  const gate = (request: Request, sessionId: string) => inRequest(request, () => access.requireSessionAccess(sessionId))
  assert.deepEqual(await thrownAnswer(await gate(reqAs(outsider), liveId)), FORBIDDEN)
  assert.deepEqual(await thrownAnswer(await gate(reqAs(member), UNKNOWN_ID)), FORBIDDEN)
  assert.deepEqual(await thrownAnswer(await gate(reqAnonymous(), liveId)), UNAUTHORIZED)
  // Control: the same id passes for the member.
  assert.deepEqual(await gate(reqAs(member), liveId), { resolved: liveKey })
})

test('requireSessionKeyAccess: a member resolves to the key and the thread agent', async () => {
  assert.deepEqual(await inRequest(reqAs(member), () => access.requireSessionKeyAccess(liveKey)), {
    resolved: { sessionKey: liveKey, agentNodeId: 'agent-session' },
  })
})

test('requireSessionKeyAccess: a non-member and an unknown key throw 403, an anonymous caller throws 401', async () => {
  const gate = (request: Request, key: string) => inRequest(request, () => access.requireSessionKeyAccess(key))
  assert.deepEqual(await thrownAnswer(await gate(reqAs(outsider), liveKey)), FORBIDDEN)
  assert.deepEqual(await thrownAnswer(await gate(reqAs(member), UNKNOWN_KEY)), FORBIDDEN)
  assert.deepEqual(await thrownAnswer(await gate(reqAnonymous(), liveKey)), UNAUTHORIZED)
  // Control: the same key passes for the member.
  assert.deepEqual(await gate(reqAs(member), liveKey), {
    resolved: { sessionKey: liveKey, agentNodeId: 'agent-session' },
  })
})

test('requireMemberSessionKeys: each caller gets their own chats’ keys, an anonymous caller throws 401', async () => {
  const mine = await inRequest(reqAs(member), () => access.requireMemberSessionKeys())
  assert.ok('resolved' in mine)
  assert.deepEqual([...mine.resolved].sort(), await chatKeys(chatA.id))
  const theirs = await inRequest(reqAs(outsider), () => access.requireMemberSessionKeys())
  assert.ok('resolved' in theirs)
  assert.deepEqual([...theirs.resolved].sort(), [foreignKey])
  assert.deepEqual(
    await thrownAnswer(await inRequest(reqAnonymous(), () => access.requireMemberSessionKeys())),
    UNAUTHORIZED,
  )
})
