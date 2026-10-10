// Who a text mentions, against a real database: the rule is that a mention is
// exactly what renders as a mention chip, so the cases are about where in the
// markdown an `@username` sits and whether an account holds it.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { beforeEach } from 'node:test'

process.env.OPENCROFT_DB_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
)
delete process.env.OPENCROFT_DATABASE_URL

const { db, user, username: usernames } = await import('@opencroft/db')
const store = await import('./usernames')
const { mentionedUsernames, mentionsIn } = await import('./mentions')
const { getSpacesRegistry } = await import('@/app/_authed/(space)/_server/store')

beforeEach(async () => {
  await db.delete(usernames)
  await db.delete(user)
})

async function person(id: string, name: string, handle: string): Promise<void> {
  await db.insert(user).values({ id, name, email: `${id}@example.test`, emailVerified: false })
  assert.deepEqual(await store.changeUsername({ kind: 'user', id }, handle), { ok: true })
}

test('a mention in prose resolves to the account holding the username', async () => {
  await person('person-1', 'Ada L', 'ada')
  await person('person-2', 'Bo', 'bo')

  assert.deepEqual(await mentionsIn('@ada, can you look? cc **@bo**'), [
    { kind: 'user', id: 'person-1', name: 'Ada L', avatarUrl: null, username: 'ada' },
    { kind: 'user', id: 'person-2', name: 'Bo', avatarUrl: null, username: 'bo' },
  ])
})

test('inline code, a code block and a link label never mention', async () => {
  await person('person-1', 'Ada L', 'ada')
  const quoted = [
    'Send `@ada reply with one comment`',
    '```\n@ada run the checks\n```',
    '[@ada](https://example.com/ada)',
  ]

  for (const text of quoted) {
    assert.deepEqual(mentionedUsernames(text), [], text)
    assert.deepEqual(await mentionsIn(text), [], text)
  }
  // The same handle outside the code in the same text still mentions.
  assert.deepEqual(
    (await mentionsIn(`${quoted[0]}, says @ada`)).map((m) => m.username),
    ['ada'],
  )
})

test('a display name mentions nobody, even where a username shares its first word', async () => {
  await person('person-1', 'Bot', 'bot')

  assert.deepEqual(mentionedUsernames('@Bot (QA) please check'), [])
  assert.deepEqual(await mentionsIn('@Bot (QA) please check'), [])
})

test('a username no account holds mentions nobody', async () => {
  await person('person-1', 'Ada L', 'ada')

  assert.deepEqual(mentionedUsernames('@nobody and @ada'), ['nobody', 'ada'])
  assert.deepEqual(
    (await mentionsIn('@nobody and @ada')).map((m) => m.id),
    ['person-1'],
  )
})

test('an account mentioned twice, by its current and a retired username, is mentioned once', async () => {
  await person('person-1', 'Ada L', 'ada')
  assert.deepEqual(await store.changeUsername({ kind: 'user', id: 'person-1' }, 'ada.l'), { ok: true })

  assert.deepEqual(
    (await mentionsIn('@ada and @ada.l and @ada')).map((m) => [m.id, m.username]),
    [['person-1', 'ada']],
  )
})

test('an agent is mentioned by its username, as the agent node holding it', async () => {
  // Agents live in space graphs rather than in the database, so this is the
  // one case that reads the node registry: the username row points at a node.
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create('Mentions', 'mentions-agents', {
    nodes: [{ id: 'agent-node-1', type: 'builtin.core.agent', position: { x: 0, y: 0 }, data: { name: 'Bot (QA)' } }],
    edges: [],
  })
  try {
    assert.deepEqual(await store.changeUsername({ kind: 'agent', id: 'agent-node-1' }, 'agent.bot.qa'), { ok: true })

    assert.deepEqual(await mentionsIn('@agent.bot.qa reply with one short comment'), [
      { kind: 'agent', id: 'agent-node-1', name: 'Bot (QA)', avatarUrl: null, username: 'agent.bot.qa' },
    ])
    // Its display name is still not a mention.
    assert.deepEqual(await mentionsIn('@Bot (QA) reply'), [])
  } finally {
    await registry.remove('mentions-agents')
  }
})

test('a text with no mention reads nothing', async () => {
  assert.deepEqual(await mentionsIn('no one here; mail ada@example.com'), [])
})
