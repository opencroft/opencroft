// Who a graph-driven message is attributed to, against a real database,
// because the agent branch resolves a stored username and a mock would assume
// the very mapping under test.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, beforeEach } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-message-author-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
process.env.DB_MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'db', 'migrations')
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'development'

const { db, user, username: usernames } = await import('@opencroft/db')
const { eq } = await import('drizzle-orm')
const store = await import('./usernames')
const {
  authorForPerson,
  isKnownSystemSender,
  SEND_MESSAGE_SYSTEM_AUTHOR,
  senderForSend,
  senderForSourceNode,
  UnattributableSendError,
} = await import('./message-author')

// The author-only projections these tests were written against. Kept as local
// views over the real exports rather than rewritten into every assertion: the
// attribution RULES under test did not change when the sender gained its
// principal half, and the principal itself is asserted in its own tests below.
const authorForSourceNode = async (
  sourceNodeId: string | undefined,
  sourceNodes: Parameters<typeof senderForSourceNode>[1],
) => (await senderForSourceNode(sourceNodeId, sourceNodes)).author
const authorForSend = async (...args: Parameters<typeof senderForSend>) => (await senderForSend(...args)).author
const authorForCallingAgent = async (agentName: string, agents: { nodeId?: string; name?: string }[]) =>
  (await senderForSend({ callerAgent: agentName }, [], async () => agents)).author

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

beforeEach(async () => {
  // Handles first: they point at the accounts, so the other order leaves the
  // rows this deletes still referenced.
  await db.delete(usernames)
  await db.delete(user)
})

// Core's types as graphs store them, and the webhook handler under whatever
// owner its extension is installed as.
const nodes = [
  { id: 'agent-1', type: 'builtin.core.agent' },
  { id: 'webhook-1', type: 'acme.forge.gitea-webhook-handler' },
  { id: 'scriptnode-1', type: 'builtin.core.script-node' },
  { id: 'route-1', type: 'builtin.core.api-route' },
  { id: 'schedule-1', type: 'builtin.core.event' },
  { id: 'script-1', type: 'builtin.core.script-bash' },
  { id: 'generator-1', type: 'builtin.core.text-generation' },
  { id: 'terminal-1', type: 'builtin.core.terminal' },
  { id: 'lookalike-1', type: 'acme.widgets.script-node' },
  { id: 'unmigrated-1', type: 'script-node' },
]

// ---------------------------------------------------------------------------
// An agent that fed the run is named, exactly
// ---------------------------------------------------------------------------

test('an agent source is attributed to that agent, by its stored handle', async () => {
  await store.changeUsername({ kind: 'agent', id: 'agent-1' }, 'agent.alice')
  assert.equal(await authorForSourceNode('agent-1', nodes), 'agent.alice')
})

test('an agent with no handle is refused rather than named something else', async () => {
  // Naming it anything else would put its words in another mouth, and the
  // system identifier is not a place to put an agent.
  await assert.rejects(() => authorForSourceNode('agent-1', nodes), UnattributableSendError)
})

test('a renamed agent keeps the handle its past messages were stamped with', async () => {
  // The point of stamping an identifier rather than a name: the display name
  // moves, the attribution does not.
  await store.changeUsername({ kind: 'agent', id: 'agent-1' }, 'agent.alice')
  const before = await authorForSourceNode('agent-1', nodes)
  assert.equal(before, 'agent.alice')
  assert.equal(await authorForSourceNode('agent-1', nodes), before, 'the same account, the same stamp')
})

// ---------------------------------------------------------------------------
// The application speaking for itself
// ---------------------------------------------------------------------------

test('the two node types that actually feed a send-message node today are attributed', async () => {
  // The live wirings, from a sweep of every space rather than from reasoning
  // about which types sound like triggers. The webhook handler is the one that
  // carries forge notifications into the team's threads; refusing it would
  // have stopped them, silently.
  assert.equal(await authorForSourceNode('webhook-1', nodes), 'system.webhook')
  assert.equal(await authorForSourceNode('scriptnode-1', nodes), 'system.script')
})

test('the anticipatory triggers are attributed too, and say which kind', async () => {
  assert.equal(await authorForSourceNode('route-1', nodes), 'system.route')
  assert.equal(await authorForSourceNode('schedule-1', nodes), 'system.schedule')
  assert.equal(await authorForSourceNode('script-1', nodes), 'system.script')
})

test('a transformer is refused: it is not what triggered the run', async () => {
  // Something fed it and it passed something on, so naming it the author would
  // report the transport and call it the sender. Refusing announces itself when
  // one is first wired; guessing would not.
  await assert.rejects(() => authorForSourceNode('generator-1', nodes), UnattributableSendError)
})

// ---------------------------------------------------------------------------
// The refusals -- the half that decides whether any of this is worth anything
// ---------------------------------------------------------------------------

test('nothing fed the run, so there is no sender and the send is refused', async () => {
  // The exact hole the system identifier must not fill: fired directly, or by
  // something that supplies no source.
  await assert.rejects(() => authorForSourceNode(undefined, nodes), UnattributableSendError)
})

test('a source that is not in the graph is refused', async () => {
  await assert.rejects(() => authorForSourceNode('ghost-1', nodes), UnattributableSendError)
})

test('a node type nobody classified is refused, not assumed to be the system', async () => {
  // The allow-list earns its keep here. "Not an agent, therefore the system"
  // would quietly make `system.` the bucket for everything unconsidered, and
  // an author nobody checked is worth exactly what a tool name is worth.
  await assert.rejects(() => authorForSourceNode('terminal-1', nodes), UnattributableSendError)
})

test("a core trigger's name declared by another extension, or stored bare, is not that trigger", async () => {
  await assert.rejects(() => authorForSourceNode('lookalike-1', nodes), UnattributableSendError)
  await assert.rejects(() => authorForSourceNode('unmigrated-1', nodes), UnattributableSendError)
})

// ---------------------------------------------------------------------------
// A person sending in their own name
// ---------------------------------------------------------------------------

test('a person is attributed by their stored handle, not by the name they are shown under', async () => {
  // The whole reason the handle exists. A display name in the tag cannot be
  // resolved back to an account: it is free text, it is not unique, and it
  // moves. So the assertion is against the handle AND against the name, since
  // stamping the name is the behaviour being replaced.
  await db.insert(user).values({ id: 'person-1', name: 'Ada L', email: 'person-1@example.test', emailVerified: false })
  await store.changeUsername({ kind: 'user', id: 'person-1' }, 'ada')

  const author = await authorForPerson('person-1')

  assert.equal(author, 'ada')
  assert.notEqual(author, 'Ada L', 'the display name must not be what a message is stamped with')
})

test('a person keeps the handle their past messages were stamped with after a rename', async () => {
  await db.insert(user).values({ id: 'person-2', name: 'Bo', email: 'person-2@example.test', emailVerified: false })
  await store.changeUsername({ kind: 'user', id: 'person-2' }, 'bo')
  await db.update(user).set({ name: 'Bo the Second' }).where(eq(user.id, 'person-2'))

  // Renaming the account changes what a reader sees, never what was stamped:
  // the stamp is the thing the rename is not allowed to move.
  assert.equal(await authorForPerson('person-2'), 'bo')
})

test('a person who has no handle yet is given one rather than refused', async () => {
  // Somebody who signed up after this process started. The startup pass will
  // never reach them, and refusing would mean a new account cannot speak until
  // the next restart.
  await db.insert(user).values({ id: 'person-3', name: 'Frank', email: 'person-3@example.test', emailVerified: false })

  const author = await authorForPerson('person-3')

  assert.equal(author, 'frank')
  assert.equal(await store.currentUsername({ kind: 'user', id: 'person-3' }), 'frank', 'and it is stored, not derived')
})

test('the handle a person is given is never one somebody else already holds', async () => {
  // The collision that makes a display-name fallback unsafe, met head-on: the
  // new account is displayed under exactly an existing handle. It must not be
  // handed that handle, because every message the other account ever sent
  // would then be ambiguous.
  await db.insert(user).values({ id: 'person-4', name: 'Ada', email: 'person-4@example.test', emailVerified: false })
  await store.changeUsername({ kind: 'user', id: 'person-4' }, 'ada')
  await db.insert(user).values({ id: 'person-5', name: 'Ada', email: 'person-5@example.test', emailVerified: false })

  const author = await authorForPerson('person-5')

  assert.notEqual(author, 'ada', 'the handle already belongs to somebody')
  assert.equal(await authorForPerson('person-4'), 'ada', 'and the holder keeps it')
})

test('a message from an account that no longer exists is refused', async () => {
  // The refusal nothing can repair. There is no display name to fall back to
  // and no account to give a handle, so naming it anything would be an
  // invention.
  await assert.rejects(() => authorForPerson('person-gone'), UnattributableSendError)
})

// ---------------------------------------------------------------------------
// An agent that invoked the action, rather than one that fed the run
// ---------------------------------------------------------------------------

const agents = [
  { nodeId: 'agent-1', name: 'Alice' },
  { nodeId: 'agent-9', name: 'Solo' },
]

test('a calling agent is attributed by the handle its node already holds', async () => {
  await store.changeUsername({ kind: 'agent', id: 'agent-1' }, 'agent.alice')
  assert.equal(await authorForCallingAgent('Alice', agents), 'agent.alice')
})

test('a calling agent is looked up by the name it is called, and stamped with what that resolves to', async () => {
  // The two are deliberately different strings here, because a test where the
  // name and the handle look alike passes whichever one the code stamps.
  await store.changeUsername({ kind: 'agent', id: 'agent-9' }, 'not.the.display.name')

  const author = await authorForCallingAgent('Solo', agents)

  assert.equal(author, 'not.the.display.name')
  assert.notEqual(author, 'Solo', 'the display name must not be what a message is stamped with')
})

test('a calling agent with no handle yet is given one, unlike one that merely fed a run', async () => {
  // The difference `authorForAgentNode` exists for: here the caller NAMED the
  // agent it is sending as, so there is something to seed a handle from. A
  // node found in the graph carries no such statement, and that path still
  // refuses -- pinned by the agent-with-no-handle test further up.
  const author = await authorForCallingAgent('Alice', agents)

  assert.equal(author, 'agent.alice')
  assert.equal(await store.currentUsername({ kind: 'agent', id: 'agent-1' }), 'agent.alice', 'and it is stored')
})

test('a name matching no agent is refused', async () => {
  await assert.rejects(() => authorForCallingAgent('Nobody', agents), UnattributableSendError)
})

test('a name matching two agents is refused as firmly as one matching none', async () => {
  // A display name is free text and two nodes can carry one. Picking either
  // would deliver the message as an agent that did not send it, so ambiguous
  // and unknown are the same refusal.
  const twins = [
    { nodeId: 'agent-twin-a', name: 'Twin' },
    { nodeId: 'agent-twin-b', name: 'Twin' },
  ]
  await assert.rejects(() => authorForCallingAgent('Twin', twins), UnattributableSendError)
})

// ---------------------------------------------------------------------------
// Which of the two facts decides, and in which order
// ---------------------------------------------------------------------------

const noAgents = async () => {
  throw new Error('the agent listing must not be reached on a path that has a source node')
}

test('a run with a source node is attributed to it, and never looks for a caller', async () => {
  await store.changeUsername({ kind: 'agent', id: 'agent-1' }, 'agent.alice')

  // The thunk throws if it is called at all: every webhook and every schedule
  // takes this path, and none of them should pay for a registry walk.
  assert.equal(await authorForSend({ sourceNodeId: 'webhook-1' }, nodes, noAgents), 'system.webhook')
})

test('a source node wins over a caller when somehow both are present', async () => {
  // Where both exist the text has an origin of its own, and preferring the
  // caller would attribute a forwarded message to whoever forwarded it.
  assert.equal(
    await authorForSend({ sourceNodeId: 'webhook-1', callerAgent: 'Alice' }, nodes, noAgents),
    'system.webhook',
  )
})

test('a run with no source node but an identified caller is attributed to that caller', async () => {
  // The defect this whole change is about: an agent invoking the action
  // directly has no upstream node by definition, and that is not the same
  // fact as having no sender.
  await store.changeUsername({ kind: 'agent', id: 'agent-1' }, 'agent.alice')

  assert.equal(await authorForSend({ callerAgent: 'Alice' }, nodes, async () => agents), 'agent.alice')
})

test('a run with neither a source node nor a caller is still refused, in the same words', async () => {
  // The refusal is not relaxed by any of this. Matching the message and not
  // just the class, because widening it to cover the direct-invocation case is
  // exactly the mistake this change must not make.
  await assert.rejects(() => authorForSend({}, nodes, async () => agents), {
    name: 'Error',
    message: 'This message has no sender: nothing fed the node that sent it.',
  })
})

test('a caller the surface could not name is refused like no caller at all', async () => {
  // `undefined` is what a surface that resolved nobody hands over. It must not
  // become a lookup for an agent named "undefined", and it must not become a
  // reason to attribute anything.
  await assert.rejects(() => authorForSend({ callerAgent: undefined }, nodes, async () => agents), {
    message: 'This message has no sender: nothing fed the node that sent it.',
  })
})

// ---------------------------------------------------------------------------
// The principal — what a membership gate checks — is derived with the author
// ---------------------------------------------------------------------------

test('a system source yields a system principal that IS its transcript identity', async () => {
  // One identity, both halves: the members list authorizes exactly the name
  // the transcript shows, so a granted sender and a displayed sender can
  // never be two different things.
  assert.deepEqual(await senderForSourceNode('scriptnode-1', nodes), {
    author: 'system.script',
    principal: { kind: 'system', systemId: 'system.script' },
  })
  assert.deepEqual(await senderForSourceNode('webhook-1', nodes), {
    author: 'system.webhook',
    principal: { kind: 'system', systemId: 'system.webhook' },
  })
})

test('every system identity this module can stamp is one a grant may name', async () => {
  // The coupling that makes a grant mean anything, and it has two failure
  // directions. A trigger added to the author map but missing from the
  // grantable set is stampable-but-ungrantable: a pipeline nobody can
  // authorize. A name in the set that nothing stamps is grantable-but-unused:
  // a row that reads as granted and authorizes nothing. Deriving one from the
  // other closes both; this walks the fixture the attribution tests already
  // use, rather than a list restated here, so it still fails if the
  // derivation is replaced by a copy.
  let stamped = 0
  for (const node of nodes) {
    const sender = await senderForSourceNode(node.id, nodes).catch(() => null)
    if (sender?.principal.kind !== 'system') {
      continue
    }
    stamped += 1
    assert.ok(
      isKnownSystemSender(sender.principal.systemId),
      `${node.type} stamps ${sender.principal.systemId}, which no grant could name`,
    )
  }
  assert.ok(stamped >= 5, `the sweep found only ${stamped} system senders — the fixture stopped covering them`)

  // The machinery's own voice is not in that map, and it is the one sender the
  // in-thread failure reporter needs a row for.
  assert.equal(isKnownSystemSender(SEND_MESSAGE_SYSTEM_AUTHOR), true)

  // The namespace is not the population: a near-miss of a real sender is not a
  // sender, and neither is anything else wearing the prefix.
  assert.equal(isKnownSystemSender('system.scripts'), false)
  assert.equal(isKnownSystemSender('system.'), false)
  assert.equal(isKnownSystemSender('agent.alice'), false)
})

test('an agent source yields an agent principal carrying its NODE id, not its handle', async () => {
  // Membership rows are keyed by agent node id; the handle is display. A
  // rename must not detach an agent from its grants.
  await store.changeUsername({ kind: 'agent', id: 'agent-1' }, 'agent.alice')
  assert.deepEqual(await senderForSourceNode('agent-1', nodes), {
    author: 'agent.alice',
    principal: { kind: 'agent', agentNodeId: 'agent-1' },
  })
})

test('a calling agent yields an agent principal for the node its name resolved to', async () => {
  const sender = await senderForSend({ callerAgent: 'Alice' }, [], async () => agents)
  assert.deepEqual(sender.principal, { kind: 'agent', agentNodeId: 'agent-1' })
})
