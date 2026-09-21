// What the listings HAND OUT, which is the half of this change that does
// anything.
//
// Acceptance is not vocabulary; emission is. An agent spends what a listing
// gave it and what an error taught it, so a resolver that takes both spellings
// changes nothing on its own: while `app_list` prints uuids, uuids are what
// gets pasted into the next instruction, the next ticket and the next note.
// Slug addressing is not done while that is true, so this file asserts the
// listings are clean rather than trusting a diff to have caught every field.
//
// The same file now also holds what `app_list` must NOT hand out for the
// second reason: size. Action declarations belong to an App and were printed
// per app added from it, so a space holding twelve of one App printed twelve
// identical copies. The assertions below pin the split that fixed it —
// `app_list` names, `app_actions` declares, `app_get` configures.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, spaceApp } from '@opencroft/db'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { GRAPH_APP_EXTENSION_ID, GRAPH_APP_SLUG } from '@/app/_authed/(space)/_server/types'
import { appDetail, listAppActions, listAppCatalog, listSpaceApps } from './runtime'

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i

const suffix = crypto.randomUUID().slice(0, 8)
const spaceSlug = `app-emitters-${suffix}`

const registry = getSpacesRegistry()
await registry.ensureLoaded()
const space = await registry.create(spaceSlug, spaceSlug, { nodes: [], edges: [] })
const [row] = await db
  .insert(spaceApp)
  .values({
    spaceId: space.id,
    extensionId: GRAPH_APP_EXTENSION_ID,
    appSlug: GRAPH_APP_SLUG,
    name: 'Reports',
    slug: 'reports',
  })
  .returning()
const address = `${spaceSlug}.${row.slug}`

// The App this file adds TWO of, to have a type whose action list is worth
// deduplicating. Chosen at runtime as the first one in the tree that declares
// any, rather than named: a host test that names an extension knows about a
// layer above it, and it would start failing the day that extension changes
// its mind about having actions.
const catalog = await listAppCatalog()
const unambiguous = catalog.filter((entry) => catalog.filter((o) => o.appSlug === entry.appSlug).length === 1)
let acting: { appSlug: string; extensionId: string; ids: string[] } | undefined
for (const entry of unambiguous) {
  const actions = await listAppActions(entry.appSlug)
  if (actions.length > 0) {
    acting = { appSlug: entry.appSlug, extensionId: entry.extensionId, ids: actions.map((action) => action.id) }
    break
  }
}
if (acting) {
  const { extensionId, appSlug } = acting
  await db.insert(spaceApp).values(
    ['first', 'second'].map((slug) => ({
      spaceId: space.id,
      extensionId,
      appSlug,
      name: `Acting ${slug}`,
      slug: `acting-${slug}`,
    })),
  )
}

/** The chosen App, or the reason the tests below could not have meant anything. */
function actingApp() {
  if (!acting) {
    throw new Error('No App in this tree declares an action — these tests would quantify over nothing.')
  }
  return acting
}

// THE CONTROL, and this file is worthless without it. Every assertion below is
// "no uuid appears", which passes just as happily against a detector that
// cannot recognise one. So prove the pattern fires on the id that really is
// there, in the row the listing is about.
test('CONTROL: the uuid pattern matches the id this instance actually has', () => {
  assert.match(row.id, UUID, 'the row carries a uuid, and the detector sees it')
  assert.doesNotMatch(address, UUID, 'while the address it should be listed under is not one')
})

test('app_list keys every app by its address', async () => {
  const listing = await listSpaceApps(spaceSlug)
  const reports = listing.apps[address]
  assert.ok(reports, `the app is listed under ${address}`)
  assert.equal(reports.type, GRAPH_APP_SLUG, 'carrying the App it is an instance of')
  assert.equal(reports.name, row.name, 'and the name its user gave it')
})

// The class assertion: not "the instanceId field is gone" -- which one rename
// would satisfy while a uuid sat in some other field -- but that nothing in
// what the caller receives is a uuid at all.
test('app_list hands out no uuid, in any field', async () => {
  const listing = await listSpaceApps(spaceSlug)
  assert.ok(Object.keys(listing.apps).length > 0, 'the listing is not empty, or this asserts nothing')
  const serialised = JSON.stringify(listing)
  assert.doesNotMatch(serialised, UUID, `a uuid reached the caller: ${serialised}`)
})

// The size defect itself, stated as the property that fixes it. Two apps of
// one type, one action list -- and the list is real rather than empty, which
// is what `acting` exists to guarantee.
test('app_list declares a type’s actions once, however many apps have that type', async () => {
  const chosen = actingApp()
  const listing = await listSpaceApps(spaceSlug)
  const sameType = Object.values(listing.apps).filter((app) => app.type === chosen.appSlug)
  assert.equal(sameType.length, 2, 'the space holds two apps of that type')
  assert.deepEqual(listing.actions[chosen.appSlug], chosen.ids, 'named once, under the type')
  for (const app of Object.values(listing.apps)) {
    assert.ok(!('actions' in app), 'and never repeated on an app')
  }
})

test('app_list names exactly the action ids app_actions loads', async () => {
  const listing = await listSpaceApps(spaceSlug)
  for (const [type, ids] of Object.entries(listing.actions)) {
    const loaded = await listAppActions(type)
    assert.deepEqual(
      ids,
      loaded.map((action) => action.id),
      `the two listings agree about ${type}`,
    )
  }
})

test('app_actions answers an app’s address the same as its type', async () => {
  const byType = await listAppActions(actingApp().appSlug)
  const byAddress = await listAppActions(`${spaceSlug}.acting-first`)
  assert.deepEqual(byAddress, byType, 'actions belong to the App, so both spellings reach the same ones')
})

test('app_actions loads only the actions asked for', async () => {
  const chosen = actingApp()
  const [first] = chosen.ids
  const loaded = await listAppActions(chosen.appSlug, [first])
  assert.deepEqual(
    loaded.map((action) => action.id),
    [first],
  )
})

// "No actions declared" and "no such App" are different answers, and an empty
// list says the first about a question that was really the second.
test('app_actions refuses an unknown type rather than reporting no actions', async () => {
  await assert.rejects(() => listAppActions(`no-such-app-type-${suffix}`), /No App type/)
})

test('app_actions refuses an action the App does not declare', async () => {
  await assert.rejects(() => listAppActions(GRAPH_APP_SLUG, ['no-such-action']), /no action/)
})

test('app_get carries the parameters app_list leaves out', async () => {
  const detail = await appDetail(address)
  assert.equal(detail.address, address, 'addressed <space>.<slug>')
  assert.equal(detail.extensionId, GRAPH_APP_EXTENSION_ID, 'and says which extension provides its App')
  assert.deepEqual(detail.params, {}, 'with the values it was added with')
  assert.ok(Array.isArray(detail.parameters), 'and the fields those values fill')
  const listing = await listSpaceApps(spaceSlug)
  assert.ok(!('params' in listing.apps[address]), 'which is exactly what app_list does not print')
})

test('app_get refuses a reference that names no app', async () => {
  await assert.rejects(() => appDetail(`${spaceSlug}.no-such-app`), /Unknown app/)
})

// `list_spaces` is the other emitter that used to hand out an App instance id —
// one per graph, since every graph is a Graph App instance. Imported lazily:
// the MCP modules reach the tools barrel through the approvals wrapper and it
// imports them straight back, so a static import from here enters that cycle.
test('list_spaces addresses every graph and hands out no app uuid', async () => {
  const { handlers } = await import('@/app/_authed/(mcp)/_server/space-tools')
  const result = (await handlers.list_spaces({}, { agent: null } as never)) as {
    content: { text: string }[]
  }
  const listing = JSON.parse(result.content[0].text) as { slug: string; graphs: Record<string, unknown>[] }[]
  const mine = listing.find((entry) => entry.slug === spaceSlug)
  assert.ok(mine, 'the space this test made is in the listing')
  assert.ok(mine.graphs.length > 0, 'with its graphs, or the assertion below quantifies over nothing')
  for (const graph of mine.graphs) {
    assert.match(String(graph.address), new RegExp(`^${spaceSlug}\\.`), 'every graph carries its address')
    assert.doesNotMatch(JSON.stringify(graph), UUID, `a uuid reached the caller: ${JSON.stringify(graph)}`)
  }
})

// Scoped to the graph entries on purpose, and this is the one exclusion worth
// stating. Each space in that listing still carries its own row `id`, which is
// a uuid -- but it is a SPACE id, not an app one, and no tool anywhere accepts
// it as an address: spaces have been addressed by slug all along. So it is not
// the identifier this work is about and not the silent-wrong-target class,
// and widening the diff to drop it would be a change nobody asked for against
// a field something may well be reading.
test('CONTROL: the space id is the only uuid left in that listing, and it is deliberate', async () => {
  const { handlers } = await import('@/app/_authed/(mcp)/_server/space-tools')
  const result = (await handlers.list_spaces({}, { agent: null } as never)) as {
    content: { text: string }[]
  }
  const listing = JSON.parse(result.content[0].text) as { slug: string; id?: string }[]
  const mine = listing.find((entry) => entry.slug === spaceSlug)
  assert.ok(mine, 'the space is listed')
  assert.match(String(mine.id), UUID, 'the space id is a uuid, and that is what the test above is excluding')
})
