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
const { authorForPerson, authorForSourceNode, UnattributableSendError } = await import('./message-author')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

beforeEach(async () => {
  // Handles first: they point at the accounts, so the other order leaves the
  // rows this deletes still referenced.
  await db.delete(usernames)
  await db.delete(user)
})

const nodes = [
  { id: 'agent-1', type: 'agent' },
  { id: 'webhook-1', type: 'gitea-webhook-handler' },
  { id: 'scriptnode-1', type: 'script-node' },
  { id: 'route-1', type: 'api-route' },
  { id: 'schedule-1', type: 'event' },
  { id: 'script-1', type: 'script-bash' },
  { id: 'generator-1', type: 'text-generation' },
  { id: 'terminal-1', type: 'terminal' },
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
