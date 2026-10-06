// Exercises the real database (embedded PGlite by default) — see @opencroft/db's
// test-env for how this stays off the shared dev/production database regardless
// of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getSpacesRegistry, type SpaceRuntime, SpaceSlugTakenError } from './store'

async function freshSpace(slug: string) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  return registry.create(slug, slug, { nodes: [], edges: [] })
}

// The graph a bare space address resolves to -- what these tests write.
function defaultGraph(space: SpaceRuntime) {
  return space.graphs.get(space.defaultGraphSlug)!
}

// ---------------------------------------------------------------------------
// RENAMING MOVES A SPACE'S ADDRESS. The slug is in canvas URLs, in agents'
// tool calls, and in whatever an extension was configured with -- so
// a rename that left it behind is the same defect a renamed group chat had, and
// the freed address has to keep resolving.
// ---------------------------------------------------------------------------

test('renaming a space moves its slug, and the freed one still resolves to it', async () => {
  const registry = getSpacesRegistry()
  const original = `store-rename-${crypto.randomUUID()}`
  const space = await freshSpace(original)

  const renamed = await registry.rename(original, 'Delivery Crew')
  assert.ok(renamed)
  assert.equal(renamed.name, 'Delivery Crew')
  assert.equal(renamed.slug, 'delivery-crew', 'the address follows the name -- what the rename is for')

  assert.equal(registry.getBySlug('delivery-crew')?.id, space.id)
  assert.equal(registry.getBySlug(original)?.id, space.id, 'a bookmarked URL must still land on the space it named')
  assert.equal(
    registry.list().some((s) => s.slug === original),
    false,
    'the freed slug resolves but is not a space of its own',
  )

  // Renaming again works from the current address and keeps both freed ones.
  const again = await registry.rename('delivery-crew', 'Delivery Crew Two')
  assert.ok(again)
  assert.equal(again.slug, 'delivery-crew-two')
  assert.equal(registry.getBySlug(original)?.id, space.id)
  assert.equal(registry.getBySlug('delivery-crew')?.id, space.id)
})

test('a rename that does not move the slug leaves the address alone', async () => {
  const registry = getSpacesRegistry()
  const slug = `store-rename-same-${crypto.randomUUID()}`
  await freshSpace(slug)

  // The name changes; its slug is what the space already answers to, so the
  // address must not be suffixed into a new one.
  const renamed = await registry.rename(slug, slug.toUpperCase())
  assert.ok(renamed)
  assert.equal(renamed.slug, slug)
})

test('a live space outranks a freed address, and taking one drops the alias', async () => {
  const registry = getSpacesRegistry()
  const original = `store-rename-reuse-${crypto.randomUUID()}`
  const first = await freshSpace(original)
  const moved = await registry.rename(original, `moved ${crypto.randomUUID()}`)
  assert.ok(moved)
  assert.equal(registry.getBySlug(original)?.id, first.id)

  // A second space now claims exactly the address the first one freed.
  const second = await registry.create(original, original, { nodes: [], edges: [] })
  assert.equal(
    registry.getBySlug(original)?.id,
    second.id,
    'the space holding the address now is the answer, not the one that used to',
  )

  // And the alias is gone rather than merely outranked at read time.
  await registry.remove(second.slug)
  assert.equal(registry.getBySlug(original), null)
})

test('renaming onto an address another space holds is refused, and changes nothing', async () => {
  const registry = getSpacesRegistry()
  const occupied = `store-rename-taken-${crypto.randomUUID()}`
  await freshSpace(occupied)
  const mover = await freshSpace(`store-rename-mover-${crypto.randomUUID()}`)

  await assert.rejects(() => registry.rename(mover.slug, occupied), SpaceSlugTakenError)

  // Not even the display name moves -- a refused rename is not a partial one.
  const after = registry.getBySlug(mover.slug)
  assert.equal(after?.slug, mover.slug)
  assert.equal(after?.name, mover.name)
})

test('an alias does not count as taken, so an address can be handed between spaces', async () => {
  const registry = getSpacesRegistry()
  const wanted = `store-rename-handover-${crypto.randomUUID()}`
  const holder = await freshSpace(wanted)
  const wanting = await freshSpace(`store-rename-wanting-${crypto.randomUUID()}`)

  // The holder steps off the address; it keeps resolving to the holder for now.
  await registry.rename(wanted, `Moved ${crypto.randomUUID()}`)
  assert.equal(registry.getBySlug(wanted)?.id, holder.id)

  // The second space claims it. If an alias read as taken this would refuse and
  // the address could never be handed over at all.
  const taken = await registry.rename(wanting.slug, wanted)
  assert.ok(taken)
  assert.equal(taken.slug, wanted)
  assert.equal(registry.getBySlug(wanted)?.id, wanting.id, 'the space holding it now is the answer')
})

// REGRESSION, found by trying it rather than by reading the code: adding the
// alias to `getBySlug` left three other slug-addressed methods resolving live
// only, and the misses are silent in different ways -- a canvas autosaving under
// the address its page was loaded with simply stops saving.
//
// Every method that takes a slug goes through one resolver now, so this covers
// the class rather than the three instances.
test('every slug-addressed operation reaches a space through an address a rename freed', async () => {
  const registry = getSpacesRegistry()
  const freed = `store-reach-${crypto.randomUUID()}`
  const space = await freshSpace(freed)
  const renamed = await registry.rename(freed, `Reached ${crypto.randomUUID()}`)
  assert.ok(renamed)
  assert.notEqual(renamed.slug, freed)

  // Graph writes and reads: addressed by whatever slug the open page was
  // loaded with, so a rename in another tab must not strand them.
  assert.equal(
    registry.resolveGraph(freed)?.graph,
    defaultGraph(renamed),
    'resolveGraph must resolve a freed address to the renamed space’s graph',
  )

  const pinned = await registry.setPinned(freed, true)
  assert.equal(pinned?.pinned, true, 'setPinned must resolve a freed address')

  // And removal, so a stale reference can still delete what it names.
  assert.equal(await registry.remove(freed), true)
  assert.equal(registry.getBySlug(freed), null)
  assert.equal(registry.getBySlug(renamed.slug), null)
  assert.equal(registry.getById(space.id), null)
})
