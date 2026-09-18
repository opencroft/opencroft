// What the listings HAND OUT, which is the half of this change that does
// anything.
//
// Acceptance is not vocabulary; emission is. An agent spends what a listing
// gave it and what an error taught it, so a resolver that takes both spellings
// changes nothing on its own: while `app_list` prints uuids, uuids are what
// gets pasted into the next instruction, the next ticket and the next note.
// Slug addressing is not done while that is true, so this file asserts the
// listings are clean rather than trusting a diff to have caught every field.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, spaceApp } from '@opencroft/db'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { GRAPH_APP_EXTENSION_ID, GRAPH_APP_SLUG } from '@/app/_authed/(space)/_server/types'
import { listSpaceAppInfos } from './runtime'

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

// THE CONTROL, and this file is worthless without it. Every assertion below is
// "no uuid appears", which passes just as happily against a detector that
// cannot recognise one. So prove the pattern fires on the id that really is
// there, in the row the listing is about.
test('CONTROL: the uuid pattern matches the id this instance actually has', () => {
  assert.match(row.id, UUID, 'the row carries a uuid, and the detector sees it')
  assert.doesNotMatch(`${spaceSlug}.${row.slug}`, UUID, 'while the address it should be listed under is not one')
})

test('app_list gives every instance its address', async () => {
  const infos = await listSpaceAppInfos(spaceSlug)
  const reports = infos.find((info) => info.slug === row.slug)
  assert.ok(reports, 'the instance is listed')
  assert.equal(reports.address, `${spaceSlug}.${row.slug}`, 'addressed <space>.<slug>')
})

// The class assertion: not "the instanceId field is gone" -- which one rename
// would satisfy while a uuid sat in some other field -- but that nothing in
// what the caller receives is a uuid at all.
test('app_list hands out no uuid, in any field', async () => {
  const infos = await listSpaceAppInfos(spaceSlug)
  assert.ok(infos.length > 0, 'the listing is not empty, or this asserts nothing')
  const serialised = JSON.stringify(infos)
  assert.doesNotMatch(serialised, UUID, `a uuid reached the caller: ${serialised}`)
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
