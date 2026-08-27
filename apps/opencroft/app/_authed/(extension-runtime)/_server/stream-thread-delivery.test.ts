// Proves the send-message node's `thread` envelope field end to end:
// reachability gated by THIS node's own graph wiring, refusal for an unknown
// or unreachable thread, and that the
// agent:job envelope path — refactored to share resolveOrCreateSession with
// the thread path — behaves exactly as it did before.
//
// Same PGLITE_PATH-before-any-db-import discipline as model.test.ts: this
// exercises the real group-chats model behind the registered resolver, not a
// stand-in for it.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import type { AgentConnection } from 'agent-client/connection'
import { buildSpawnConfig } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'

import { slug } from '@/app/_authed/(server)/_server/types'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-thread-delivery-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
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
process.env.NODE_ENV = 'development'

// These suites are about routing and delivery, not about who a message is
// from, so they pass an author that is already established -- the same thing
// the entry points hand in. Authorship itself is covered in message-author's
// own tests and in the wire test below.
const SENT_BY = 'system.schedule'

const { db, space } = await import('@opencroft/db')
const model = await import('@/app/_authed/(group-chats)/_server/model')
const stream = await import('./stream')

stream.registerThreadDeliveryResolver(model.deliverThreadFromNode)

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

// A real space so requireAgentNode/listAgentNodesImpl resolve these names —
// 'agent-session' carries a full provider/adapter/model triple so a real mock
// connection can be seeded for it; 'agent-idle' has none and is never sent to.
await db.insert(space).values({
  slug: 'thread-delivery-space',
  name: 'Thread Delivery Space',
  data: JSON.stringify({
    nodes: [
      { id: 'agent-idle', type: 'agent', data: { name: 'Agent Idle' } },
      {
        id: 'agent-session',
        type: 'agent',
        data: { name: 'Agent Session', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
    ],
    edges: [],
  }),
})

// A SECOND space, for the one test that drives the STREAM rather than calling
// the delivery directly. It needs what the others do not: the source-to-
// send-message wiring in the graph the registry serves, because that is what
// `persistToDownstreamSendMessages` walks to find where a completed stream
// goes. Kept apart from the space above so nothing here changes what those
// tests resolve.
await db.insert(space).values({
  slug: 'stream-failure-space',
  name: 'Stream Failure Space',
  data: JSON.stringify({
    nodes: [
      {
        id: 'sf-agent',
        type: 'agent',
        data: { name: 'Stream Failure Agent', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
      // A classified trigger, so the author resolves and the failure under test
      // is NOT the unattributable-sender refusal -- which is the whole point:
      // the refusal already reached a reader before this change.
      { id: 'sf-src', type: 'script-node', data: {} },
      { id: 'sf-sm', type: 'send-message', data: {} },
      { id: 'sf-job', type: 'agent-job', data: { name: 'Task', context: 'do the thing' } },
    ],
    edges: [
      { source: 'sf-src', sourceHandle: 'stdout-out', target: 'sf-sm', targetHandle: 'text-in' },
      // Reachability for the thread's agent, from this node's own graph.
      { source: 'sf-job', target: 'sf-agent' },
    ],
  }),
})

async function makeUser(email: string): Promise<{ id: string; cookie: string }> {
  const { ensureAuth } = await import('@opencroft/auth/server')
  const result = await ensureAuth().api.signUpEmail({
    body: { name: email, email, password: 'password123456' },
    asResponse: true,
  })
  const setCookie = result.headers.get('set-cookie')
  assert.ok(setCookie)
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie)
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

function reqAs(u: { cookie: string }): Request {
  return new Request('http://localhost:9999/', { headers: { cookie: u.cookie } })
}

// Waits for a condition and gives up loudly, rather than sleeping for a length
// of time and hoping. Examined during a sweep for tests bounded by a guess;
// this is the shape those were changed INTO.
async function waitForPrompts(prompts: string[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (prompts.length >= count) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`expected ${count} prompt(s) to reach the agent, saw ${prompts.length}`)
}

function seedAgentSessionConnection(connection: AgentConnection, agentName = 'Agent Session'): void {
  const workspaceSlug = slug(agentName)
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
}

// The send-message node's own graph, kept deliberately separate from the real
// DB-backed space above EXCEPT for the agent node id: that one has to match
// the real 'agent-session' node, both for reachability (isAgentNodeReachable
// checks the DB thread row's agentNodeId against this graph, by id) and for
// the agent:job envelope regression test below, whose route resolves an
// agentNodeId that ensureLocalSessionImpl then looks up in the REAL space
// registry — an invented id would fail there with "Agent node not found",
// independent of anything under test. The job node's id is free to be
// synthetic; nothing re-resolves it against the real registry. 'agent-session'
// has a job wired to it here and is therefore reachable; 'agent-idle' has no
// presence in this graph at all, so it is unreachable — the state a thread
// pointed at an agent this node cannot otherwise route to would find itself
// in.
const sendMessageNodeGraph = () => ({
  target: { id: 'sm1', type: 'send-message', data: {} },
  nodes: [
    { id: 'sm1', type: 'send-message', data: {} },
    { id: 'agent-session', type: 'agent', data: { name: 'Agent Session' } },
    { id: 'j1', type: 'agent-job', data: { name: 'Task', context: 'do the thing' } },
  ],
  edges: [{ source: 'j1', target: 'agent-session' }],
})

test('a thread envelope delivers when the thread agent is reachable from this node, and reports delivered', async () => {
  const owner = await makeUser('thread-deliver-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'reachable delivery')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  seedAgentSessionConnection({
    newSession: async () => ({ sessionId: `thread-deliver-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection)

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const { target, nodes, edges } = sendMessageNodeGraph()
  const result = await stream.deliverToSendMessageNode(
    target,
    nodes,
    edges,
    JSON.stringify({ message: 'the hourly pass has run', thread: started.thread.sessionKey, queue: 'wait' }),
    SENT_BY,
  )

  assert.deepEqual(result, { kind: 'thread', threadRef: started.thread.sessionKey, status: 'delivered' })
  await waitForPrompts(prompts, 2)
  assert.match(prompts[1] ?? '', /the hourly pass has run/)
})

test('a thread envelope refuses cleanly when its agent is not reachable from this node', async () => {
  const owner = await makeUser('thread-unreachable-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'unreachable delivery')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-idle' })
  const [thread] = await db
    .insert((await import('@opencroft/db')).groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-idle',
      sessionKey: `group-chat:${chat.id}:agent-idle:unreachable-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const { target, nodes, edges } = sendMessageNodeGraph()
  await assert.rejects(
    () =>
      stream.deliverToSendMessageNode(
        target,
        nodes,
        edges,
        JSON.stringify({ message: 'should not land', thread: thread.sessionKey, queue: 'wait' }),
        SENT_BY,
      ),
    /not reachable/i,
  )
})

test('a thread envelope refuses cleanly for an unknown thread reference — nothing is created', async () => {
  const { target, nodes, edges } = sendMessageNodeGraph()
  await assert.rejects(
    () =>
      stream.deliverToSendMessageNode(
        target,
        nodes,
        edges,
        JSON.stringify({
          message: 'nowhere to go',
          thread: 'no-such-chat:no-such-agent:no-such-thread',
          queue: 'wait',
        }),
        SENT_BY,
      ),
    /not reachable/i,
  )
})

test('a thread and an agent/job field together are refused, not silently resolved one way', async () => {
  const { target, nodes, edges } = sendMessageNodeGraph()
  await assert.rejects(
    () =>
      stream.deliverToSendMessageNode(
        target,
        nodes,
        edges,
        JSON.stringify({ message: 'ambiguous', thread: 'a:b:c', agent: 'session', job: 'task', queue: 'wait' }),
        SENT_BY,
      ),
    /not both/i,
  )
})

test('a message already queued behind a running turn reports queued, not delivered', async () => {
  const owner = await makeUser('thread-queued-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'queued delivery')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const firstPromptGate = Promise.withResolvers<void>()
  seedAgentSessionConnection({
    newSession: async () => ({ sessionId: `thread-queued-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      const text = params.prompt.map((b) => b.text ?? '').join('')
      prompts.push(text)
      if (prompts.length === 1) {
        // Held open deliberately: the second delivery below must observe this
        // turn as still active, not race ahead of it.
        await firstPromptGate.promise
      }
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection)

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const { target, nodes, edges } = sendMessageNodeGraph()
  const result = await stream.deliverToSendMessageNode(
    target,
    nodes,
    edges,
    JSON.stringify({ message: 'arrives mid-turn', thread: started.thread.sessionKey, queue: 'wait' }),
    SENT_BY,
  )
  assert.deepEqual(result, { kind: 'thread', threadRef: started.thread.sessionKey, status: 'queued' })

  firstPromptGate.resolve()
  await waitForPrompts(prompts, 2)
})

// ---------------------------------------------------------------------------
// REGRESSION: the agent:job envelope path, refactored to share
// resolveOrCreateSession with the thread path above, behaves exactly as
// before — same session reuse, same created/forced reporting.
// ---------------------------------------------------------------------------

test('an agent:job envelope still creates then reuses one stable session, unaffected by the thread path existing', async () => {
  const prompts: string[] = []
  seedAgentSessionConnection({
    newSession: async () => ({ sessionId: `agent-job-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection)

  const { target, nodes, edges } = sendMessageNodeGraph()
  const first = await stream.deliverToSendMessageNode(
    target,
    nodes,
    edges,
    JSON.stringify({ message: 'first', agent: 'agent session', job: 'task', queue: 'wait' }),
    SENT_BY,
  )
  assert.ok(first?.kind === 'agent', 'the first delivery must resolve the agent:job path')
  assert.equal(first.created, true)
  assert.equal(first.forced, false)
  await waitForPrompts(prompts, 1)

  const second = await stream.deliverToSendMessageNode(
    target,
    nodes,
    edges,
    JSON.stringify({ message: 'second', agent: 'agent session', job: 'task', queue: 'wait' }),
    SENT_BY,
  )
  assert.ok(second?.kind === 'agent')
  assert.equal(second.sessionKey, first.sessionKey, 'the same stable session, not a second one')
  assert.equal(second.created, false, 'the second delivery reuses the session the first one created')
  await waitForPrompts(prompts, 2)
})

// ---------------------------------------------------------------------------
// The catch reaches the reporter
//
// Every test above calls the delivery directly, so none of them exercises the
// try/catch in the STREAM path -- and that catch is the whole of this change:
// the guard limiting reports to one kind of failure was removed, and nothing
// but reading the diff says the remaining path reaches the reporter at all.
// Driving the stream is what makes narrowing it again go red rather than
// silent.
// ---------------------------------------------------------------------------

test('a send that fails on the stream path reports into the thread it was aimed at', async () => {
  const owner = await makeUser('stream-failure-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'stream failure reporting')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'sf-agent' })

  const prompts: string[] = []
  seedAgentSessionConnection(
    {
      newSession: async () => ({ sessionId: `stream-failure-${crypto.randomUUID()}` }),
      prompt: async (params: { prompt: Array<{ text?: string }> }) => {
        prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
        return { stopReason: 'end_turn' }
      },
      resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
      cancel: async () => {},
      setSessionConfigOption: async () => ({}),
      closeSession: async () => ({}),
    } as unknown as AgentConnection,
    'Stream Failure Agent',
  )

  const started = await model.startThread(reqAs(owner), chat.id, 'sf-agent', 'opening message')
  await waitForPrompts(prompts, 1)

  // A failure that is NOT the unattributable-sender refusal: the payload names
  // a thread and an agent at once, which the delivery rejects before either
  // branch runs. The refusal already reached a reader before this change, so
  // testing with one would leave the widening unexercised.
  //
  // The thread it names is reachable, deliberately. A failure OF the
  // destination cannot be reported TO the destination -- that residue is named
  // in the source -- so the case worth pinning is the one where the report can
  // actually arrive.
  const payload = JSON.stringify({
    message: 'this text must not reach the thread',
    thread: started.thread.sessionKey,
    agent: 'sf-agent',
    queue: 'wait',
  })

  const outgoing = stream.getStream<{ text: string; final: boolean }>('stream-failure-space', 'sf-src', 'stdout-out')
  stream.broadcast(outgoing, { text: payload, final: true })

  await waitForPrompts(prompts, 2)
  const report = prompts[1] ?? ''
  assert.match(report, /was not delivered/, 'a person reading the thread is told the send failed')
  assert.match(report, /thread or an agent\/job session, not both/, 'and why, in the words the failure used')
  assert.match(report, /sf-sm/, 'and which wiring to go and fix')
  assert.doesNotMatch(
    report,
    /this text must not reach the thread/,
    'the undelivered text is never carried: a report that quotes it has delivered it',
  )
})
