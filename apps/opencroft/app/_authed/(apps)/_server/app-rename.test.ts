// Renaming an instance moves its address.
//
// This reverses a rule the codebase had stated in five places and argued for:
// the slug was fixed at creation so that everything written down elsewhere
// kept resolving. The maintainer reversed it knowingly, with the
// consequence put to him -- saved links stop resolving -- so what these tests
// pin is not just "the slug changed" but the things that must NOT come with
// it: no alias, no redirect, nothing silently suffixed, and above all no
// address left pointing at something that is no longer there.
//
// Against the real database, because every claim here is about which row an
// address names after a write, and a stand-in registry would be free to
// answer that however the test liked.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, spaceApp } from '@opencroft/db'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { GRAPH_APP_TYPE } from '@/app/_authed/(space)/_server/types'
import { resolveAppAddress } from './app-address'
import { renameSpaceAppImpl } from './runtime'

const suffix = crypto.randomUUID().slice(0, 8)

/** A space holding one Graph App instance that really owns a graph, as the add path would leave it. */
async function spaceWithGraphApp(spaceSlug: string, name: string, slug: string) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const space = await registry.create(spaceSlug, spaceSlug, { nodes: [], edges: [] })
  const [row] = await db.insert(spaceApp).values({ spaceId: space.id, type: GRAPH_APP_TYPE, name, slug }).returning()
  await registry.createGraph(space.slug, name, slug, row.id)
  return { space, row }
}

test('a rename moves the address, and the old one stops resolving', async () => {
  const { space, row } = await spaceWithGraphApp(`rename-basic-${suffix}`, 'Reports', 'reports')
  const before = `${space.slug}.reports`
  assert.equal((await resolveAppAddress(before))?.id, row.id, 'precondition: it answers at its original address')

  const renamed = await renameSpaceAppImpl(row.id, 'Quarterly Reports')

  assert.equal(renamed.slug, 'quarterly-reports', 'the slug is re-minted from the new name')
  assert.equal((await resolveAppAddress(`${space.slug}.quarterly-reports`))?.id, row.id, 'it answers at the new one')
  assert.equal(await resolveAppAddress(before), null, 'and the old address names nothing — no alias, no redirect')
})

// The invariant the whole Graph App rests on. A graph left behind on the old
// slug would make <space>.<app-slug> and <space>.<graph-slug> two different
// addresses for one thing, which is the failure the hook seam exists to stop.
test('the graph the instance owns moves with it', async () => {
  const { space, row } = await spaceWithGraphApp(`rename-graph-${suffix}`, 'Reports', 'reports')
  const registry = getSpacesRegistry()
  assert.equal(registry.graphByInstance(row.id)?.slug, 'reports', 'precondition: one instance, one graph, one address')

  await renameSpaceAppImpl(row.id, 'Quarterly Reports')

  assert.equal(registry.graphByInstance(row.id)?.slug, 'quarterly-reports', 'the graph followed the instance')
  assert.ok(registry.resolveGraph(`${space.slug}.quarterly-reports`), 'and resolves at the new address')
  assert.equal(registry.resolveGraph(`${space.slug}.reports`), null, 'while the old graph address is gone')
})

// THE ONE THAT WOULD HAVE BEEN SILENT. `defaultGraphSlug` is stored as a slug,
// so renaming a space's default graph without moving the pointer leaves the
// bare `<space>` address resolving to nothing -- the space's own canvas, gone,
// from a rename. Nothing else in this file would have caught it.
test("renaming the default graph takes the space's own address with it", async () => {
  const { space, row } = await spaceWithGraphApp(`rename-default-${suffix}`, 'Main', 'main')
  const registry = getSpacesRegistry()
  await registry.setDefaultGraph(space.slug, 'main')
  assert.ok(registry.resolveGraph(space.slug), 'precondition: the bare space address resolves to the default graph')

  await renameSpaceAppImpl(row.id, 'Overview')

  assert.equal(registry.getBySlug(space.slug)?.defaultGraphSlug, 'overview', 'the default pointer followed the slug')
  const bare = registry.resolveGraph(space.slug)
  assert.ok(bare, 'the bare space address still resolves — this is what a stale pointer would have broken')
  assert.equal(bare.graph.slug, 'overview')
})

test('a rename onto a taken slug is refused, and changes nothing at all', async () => {
  const { space, row } = await spaceWithGraphApp(`rename-taken-${suffix}`, 'Reports', 'reports')
  const [occupier] = await db
    .insert(spaceApp)
    .values({
      spaceId: space.id,
      type: GRAPH_APP_TYPE,
      name: 'Archive',
      slug: 'archive',
    })
    .returning()

  await assert.rejects(renameSpaceAppImpl(row.id, 'Archive'), /already answers to/)

  const after = await resolveAppAddress(`${space.slug}.reports`)
  assert.equal(after?.id, row.id, 'it still answers at its original address')
  assert.equal(after?.name, 'Reports', 'and keeps its original NAME — the refusal is total, not slug-only')
  assert.equal((await resolveAppAddress(`${space.slug}.archive`))?.id, occupier.id, 'the occupier is untouched')
})

// A divergence that is reachable rather than theoretical: a graph can hold a
// slug no app holds, so the app-level check passes and the graph-level one
// refuses. The instance must not keep an address its own App would not take.
test('a hook refusing the new address rolls the instance back whole', async () => {
  const { space, row } = await spaceWithGraphApp(`rename-rollback-${suffix}`, 'Reports', 'reports')
  const registry = getSpacesRegistry()
  const [orphan] = await db
    .insert(spaceApp)
    .values({
      spaceId: space.id,
      type: GRAPH_APP_TYPE,
      name: 'placeholder',
      slug: 'placeholder',
    })
    .returning()
  // A graph on `archive` that no app answers to — so the app check below finds
  // the slug free while the graph check does not.
  await registry.createGraph(space.slug, 'Archive', 'archive', orphan.id)

  await assert.rejects(renameSpaceAppImpl(row.id, 'Archive'), /A graph already answers to/)

  const after = await resolveAppAddress(`${space.slug}.reports`)
  assert.equal(after?.id, row.id, 'the instance kept its address')
  assert.equal(after?.name, 'Reports', 'and its name — the row was rolled back, not left half-renamed')
  assert.equal(registry.graphByInstance(row.id)?.slug, 'reports', 'and its graph never moved')
})

// Renaming to a different label that mints the SAME slug must not be treated
// as an address change -- and must not trip the taken-slug check against the
// instance's own slug.
test('a rename that mints the same slug keeps the address and still updates the name', async () => {
  const { space, row } = await spaceWithGraphApp(`rename-same-${suffix}`, 'Reports', 'reports')

  const renamed = await renameSpaceAppImpl(row.id, 'REPORTS')

  assert.equal(renamed.name, 'REPORTS', 'the label changed')
  assert.equal(renamed.slug, 'reports', 'the address did not')
  assert.equal((await resolveAppAddress(`${space.slug}.reports`))?.id, row.id, 'and still resolves')
})
