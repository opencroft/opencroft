// Against the real spaces registry and group-chat tables on a throwaway
// database (see @opencroft/db's test-env): who sees which space is a question
// about stored rows and grants, not about a fake of them.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, groupChat, groupChatMember, user } from '@opencroft/db'

import { renameSpaceAppImpl } from '@/app/_authed/(apps)/_server/runtime'
import { grantSystemSenderAsPerson, listGroupChatsForSender } from '@/app/_authed/(group-chats)/_server/model'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { registerExtensionSystemSender } from '@/app/_server/message-author'
import { appDirectoryFor, type DirectoryViewer, listSpacesFor, subscribeDirectoryListing } from './directory'
import { directoryForCaller } from './host'

async function insertTestUser(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(user).values({ id, name: 'Alice', email: `${id}@example.test` })
  return id
}

const person: DirectoryViewer = { kind: 'person', userId: 'someone' }

async function newSpace(): Promise<string> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `directory-${crypto.randomUUID()}`
  await registry.create(slug, slug, { nodes: [], edges: [] })
  return slug
}

/** A chat at `slug`, with `systemId` as a member. */
async function grantChat(slug: string, systemId: string): Promise<void> {
  const [chat] = await db.insert(groupChat).values({ slug, name: slug, topic: slug }).returning()
  await db.insert(groupChatMember).values({ groupChatId: chat.id, principalType: 'system', systemId })
}

function systemViewer(): { viewer: DirectoryViewer; systemId: string } {
  const systemId = `system.ext.test.${crypto.randomUUID()}`
  return { viewer: { kind: 'system', systemId }, systemId }
}

test('a person sees every space, with its name and icon', async () => {
  const slug = await newSpace()
  const listed = (await listSpacesFor(person)).find((space) => space.slug === slug)
  assert.equal(listed?.name, slug)
  assert.match(listed?.icon ?? '', /^preset:/)
})

test("a person's directory gives each app its address, slug, space and qualified type", async () => {
  const slug = await newSpace()
  const apps = await appDirectoryFor(person, { space: slug })
  // A new space holds its default graph, the Graph App instance at `<space>.default`.
  assert.equal(apps.length, 1)
  const [graph] = apps
  assert.equal(graph.address, `${slug}.default`)
  assert.equal(graph.slug, 'default')
  assert.equal(graph.spaceSlug, slug)
  assert.equal(graph.type, 'builtin.core.graph')
  assert.equal(typeof graph.instanceId, 'string')
  assert.ok(!('params' in graph) && !('dataDir' in graph))
})

test("a system identity sees no space until the space's chat grants it, then only that one", async () => {
  const { viewer, systemId } = systemViewer()
  const granted = await newSpace()
  const other = await newSpace()
  assert.deepEqual(await listSpacesFor(viewer), [])
  assert.deepEqual(await appDirectoryFor(viewer), [])

  await grantChat(granted, systemId)
  assert.deepEqual(
    (await listSpacesFor(viewer)).map((space) => space.slug),
    [granted],
  )
  assert.deepEqual(
    (await appDirectoryFor(viewer)).map((app) => app.address),
    [`${granted}.default`],
  )
  assert.deepEqual(await appDirectoryFor(viewer, { space: other }), [])
})

test("a grant in a chat that is no space's lets a system identity into no space", async () => {
  const { viewer, systemId } = systemViewer()
  await grantChat(`directory-chat-${crypto.randomUUID()}`, systemId)
  assert.deepEqual(await listSpacesFor(viewer), [])
})

test('a space that does not exist lists no apps', async () => {
  assert.deepEqual(await appDirectoryFor(person, { space: `directory-missing-${crypto.randomUUID()}` }), [])
})

test('a chat listed to its member says which space it is the chat of', async () => {
  const systemId = `system.ext.test.${crypto.randomUUID()}`
  const slug = await newSpace()
  const loose = `directory-chat-${crypto.randomUUID()}`
  await grantChat(slug, systemId)
  await grantChat(loose, systemId)
  const chats = await listGroupChatsForSender({ author: systemId, principal: { kind: 'system', systemId } })
  assert.equal(chats.find((chat) => chat.slug === slug)?.space, slug)
  const own = chats.find((chat) => chat.slug === loose)
  assert.ok(own && !('space' in own))
})

test('a copy bound to a call refuses once the call has ended', async () => {
  const slug = await newSpace()
  const bound = directoryForCaller('test.directory', { person: { id: 'someone', name: 'Someone', avatarUrl: null } })
  assert.ok((await bound.spaces.list()).some((space) => space.slug === slug))
  assert.equal((await bound.apps.directory({ space: slug })).length, 1)
  bound.end()
  await assert.rejects(bound.spaces.list(), /has ended/)
  await assert.rejects(bound.apps.directory(), /has ended/)
})

// Listeners are called after the write's own call returns.
const delivered = () => new Promise((resolve) => setImmediate(resolve))

test('a subscriber hears a space and an app change, each listing only what can change its answer', async () => {
  const bound = directoryForCaller('test.directory', { person: { id: 'someone', name: 'Someone', avatarUrl: null } })
  const spaceChanges: unknown[] = []
  const appChanges: unknown[] = []
  bound.spaces.subscribe((change) => {
    spaceChanges.push(change)
  })
  bound.apps.subscribe((change) => {
    appChanges.push(change)
  })
  const slug = await newSpace()
  await delivered()
  assert.deepEqual(spaceChanges, [{ subject: 'space', change: 'added' }])
  assert.deepEqual(appChanges, [{ subject: 'space', change: 'added' }])

  const [graph] = await appDirectoryFor(person, { space: slug })
  await renameSpaceAppImpl(graph.instanceId, `Renamed ${crypto.randomUUID().slice(0, 8)}`)
  await delivered()
  assert.equal(spaceChanges.length, 1)
  assert.deepEqual(appChanges.at(-1), { subject: 'app', change: 'renamed' })

  bound.end()
  await newSpace()
  await delivered()
  assert.equal(spaceChanges.length, 1, 'a subscription made through a bound copy ends with the call')
  assert.throws(() => bound.spaces.subscribe(() => {}), /has ended/)
})

test('a grant into a chat is announced as an access change', async () => {
  const heard: unknown[] = []
  const unsubscribe = subscribeDirectoryListing('spaces', (change) => {
    heard.push(change)
  })
  try {
    const systemId = registerExtensionSystemSender(`test.directory-${crypto.randomUUID().slice(0, 8)}`)
    const slug = await newSpace()
    const [chat] = await db.insert(groupChat).values({ slug, name: slug, topic: slug }).returning()
    const owner = await insertTestUser()
    await db.insert(groupChatMember).values({ groupChatId: chat.id, principalType: 'user', userId: owner })
    await grantSystemSenderAsPerson(owner, slug, systemId)
    await delivered()
    assert.deepEqual(heard.at(-1), { subject: 'access', change: 'added' })
    assert.deepEqual(
      (await listSpacesFor({ kind: 'system', systemId })).map((space) => space.slug),
      [slug],
    )
  } finally {
    unsubscribe()
  }
})

test('a throwing listener reaches neither the write nor the other listeners', async () => {
  const heard: unknown[] = []
  const unsubscribeThrowing = subscribeDirectoryListing('spaces', () => {
    throw new Error('listener failure')
  })
  const unsubscribe = subscribeDirectoryListing('spaces', (change) => {
    heard.push(change)
  })
  const logged = console.error
  console.error = () => {}
  try {
    await newSpace()
    await delivered()
    assert.deepEqual(heard, [{ subject: 'space', change: 'added' }])
  } finally {
    console.error = logged
    unsubscribeThrowing()
    unsubscribe()
  }
})

test("with no caller, a call's copy sees as the extension's own system identity", async () => {
  await newSpace()
  const bound = directoryForCaller(`test.directory-${crypto.randomUUID().slice(0, 8)}`, undefined)
  assert.deepEqual(await bound.spaces.list(), [])
})
