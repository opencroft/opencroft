// Against the real database, because what is under test is which ROW an
// address names -- and the thing that makes an address mean one row is a unique
// index on (spaceId, slug). A stand-in registry is free to answer that however
// the test would like it answered, which is the one thing it must not be free
// to do here.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, spaceApp } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { GRAPH_APP_EXTENSION_ID, GRAPH_APP_SLUG } from '@/app/_authed/(space)/_server/types'
import { isAppAddress, resolveAppAddress, unresolvedAppTarget } from './app-address'
import { transferSpaceAppImpl } from './runtime'

// Rows inserted directly: the add path mints the slug and refuses a taken one,
// and neither is what resolution does. Going through it would also make these
// tests fail for reasons that belong to a different function.
//
// The App is the host-registered Graph App on purpose. Its hooks are wired in
// code rather than read from an extension folder, so handle resolution reaches
// the hook lookup instead of dying on a missing `extension.json` — and it
// declares no `getHandleContext`, which is exactly the "the app is real, the
// handle is not" case the failure below has to tell apart.
async function spaceHolding(spaceSlug: string, appSlug: string) {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const space = await registry.create(spaceSlug, spaceSlug, { nodes: [], edges: [] })
  const [row] = await db
    .insert(spaceApp)
    .values({
      spaceId: space.id,
      extensionId: GRAPH_APP_EXTENSION_ID,
      appSlug: GRAPH_APP_SLUG,
      name: appSlug,
      slug: appSlug,
    })
    .returning()
  return { space, row }
}

const SHARED_SLUG = 'reports'
const suffix = crypto.randomUUID().slice(0, 8)
const alpha = await spaceHolding(`app-address-alpha-${suffix}`, SHARED_SLUG)
const beta = await spaceHolding(`app-address-beta-${suffix}`, SHARED_SLUG)

// The control the rest of the file rests on. "Scoped to its space" is only
// tested by a fixture that actually holds two different apps answering to the
// same slug -- without this, the scoping test below would pass just as happily
// against a fixture that never had a collision in it to get wrong.
test('CONTROL: two different apps answer to the same slug in two different spaces', () => {
  assert.equal(alpha.row.slug, beta.row.slug, 'same slug')
  assert.notEqual(alpha.row.id, beta.row.id, 'different rows')
  assert.notEqual(alpha.space.id, beta.space.id, 'different spaces')
})

test('the address and the uuid name the same row', async () => {
  const byAddress = await resolveAppAddress(`${alpha.space.slug}.${alpha.row.slug}`)
  const byUuid = await resolveAppAddress(alpha.row.id)
  assert.equal(byAddress?.id, alpha.row.id, 'the address resolves')
  assert.equal(byUuid?.id, alpha.row.id, 'the uuid still resolves -- both spellings, one definition')
})

test('an address is scoped to its space, so a shared slug is two different apps', async () => {
  const inAlpha = await resolveAppAddress(`${alpha.space.slug}.${SHARED_SLUG}`)
  const inBeta = await resolveAppAddress(`${beta.space.slug}.${SHARED_SLUG}`)
  assert.equal(inAlpha?.id, alpha.row.id)
  assert.equal(inBeta?.id, beta.row.id)
  assert.notEqual(inAlpha?.id, inBeta?.id, 'the space half is load-bearing, not decoration')
})

test('an address that names nothing resolves to nothing, never to something else', async () => {
  assert.equal(await resolveAppAddress(`${alpha.space.slug}.no-such-app`), null, 'unknown app in a real space')
  assert.equal(await resolveAppAddress(`no-such-space-${suffix}.${SHARED_SLUG}`), null, 'unknown space, real slug')
  assert.equal(await resolveAppAddress(`${alpha.space.slug}.${SHARED_SLUG}.extra`), null, 'a slug cannot hold a dot')
})

// The dot is the whole branch decision, so this is the classifier the loud
// failure hangs off: the two forms that are NOT addresses -- the `extensions`
// sentinel and a graph node id -- are dotless, exactly like a uuid.
test('isAppAddress splits on the dot, not on what either half contains', () => {
  assert.equal(isAppAddress(`${alpha.space.slug}.${SHARED_SLUG}`), true, 'an address')
  assert.equal(isAppAddress(alpha.row.id), false, 'a uuid')
  assert.equal(isAppAddress('extensions'), false, 'the local-extension sentinel')
  assert.equal(isAppAddress('core-secrets-store_xjefl3ec'), false, 'a graph node id')
})

test('an unresolvable target says which half failed', async () => {
  const handleMissing = await unresolvedAppTarget(`${alpha.space.slug}.${SHARED_SLUG}`, 'no-such-handle')
  assert.match(handleMissing, /is an app, but it exposes no handle/, 'the app was found -- the handle was the miss')
  assert.match(handleMissing, /no-such-handle/, 'and it names the handle it looked for')

  const appMissing = await unresolvedAppTarget(`${alpha.space.slug}.no-such-app`, 'terminal')
  assert.match(appMissing, /No app answers to/, 'the address itself was the miss')
  assert.match(appMissing, /<space>\.<app-slug>/, 'and it teaches the grammar')
  assert.match(appMissing, /app_list/, 'and names the tool that lists real ones')

  const neither = await unresolvedAppTarget(`no-such-node-id-${suffix}`, 'terminal')
  assert.match(neither, /no graph node, and no app/, 'a dotless miss is not silently blamed on the app path')
})

// The failure the resolver owes the DOTTED form, at the surface that actually
// serves it. Without the branch these cover, a target naming a real app and a
// handle it does not have falls through to graph-node resolution and comes back
// as a missing NODE -- the reader is sent after the one thing that was fine.
//
// Imported lazily, and this is not a style choice: remote-tools reaches
// `(mcp)/_server/tools` through the approvals wrapper, and that barrel imports
// remote-tools straight back. A static import from here enters that existing
// cycle at a point where `remoteDefinitions` is still in its temporal dead zone.
// The same reason `host.ts` imports this direction lazily.
const { resolveTerminalContext } = await import('@/app/_authed/(mcp)/_server/remote-tools')

test('a dotted target that resolves to no app fails there, not in node lookup', async () => {
  await assert.rejects(
    resolveTerminalContext({ target: `${alpha.space.slug}.no-such-app/terminal` }),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /No app answers to/)
      assert.doesNotMatch(err.message ?? '', /[Nn]ode/, 'never reported as a node problem')
      return true
    },
  )
})

test('a dotted target whose app exists but whose handle does not says so', async () => {
  await assert.rejects(
    resolveTerminalContext({ target: `${alpha.space.slug}.${SHARED_SLUG}/no-such-handle` }),
    (err: { message?: string }) => {
      assert.match(err.message ?? '', /is an app, but it exposes no handle "no-such-handle"/)
      return true
    },
  )
})

// An address is the one reference a transfer invalidates, because it names the
// instance THROUGH ITS SPACE. So the move hands the row back: a caller that has
// to say anything about the instance afterwards cannot be left holding a string
// that stopped being true halfway through its own call.
test('a transfer hands back the moved row, and the address that reached it stops resolving', async () => {
  const origin = await spaceHolding(`app-address-origin-${suffix}`, 'movable')
  await getSpacesRegistry().createGraph(origin.space.slug, 'movable', 'movable', origin.row.id)
  const from = `${origin.space.slug}.movable`

  const moved = await transferSpaceAppImpl(from, beta.space.slug)

  assert.equal(moved.id, origin.row.id, 'the same instance')
  assert.equal(moved.spaceId, beta.space.id, 'in the target space -- read off the row, not off the argument')
  assert.equal(await resolveAppAddress(from), null, 'the address the caller used now names nothing')
  assert.equal(
    (await resolveAppAddress(`${beta.space.slug}.${moved.slug}`))?.id,
    origin.row.id,
    'and the instance answers at its new one',
  )
})

// The collision case the bug report is about: a transfer landing on a slug
// the target already holds must disambiguate using the TRANSFERRED
// instance's own name/slug, not the donor space's -- an instance called
// "OpenCroft" arriving beside a target's own "opencroft" becomes
// "OpenCroft 2" / `opencroft-2`, never "Service" / `service` just because
// that happened to be the space it came from.
test("a transfer onto a taken slug suffixes its OWN name and slug, not the donor space's", async () => {
  // Donor space is named "Service" on purpose -- an implementation that
  // falls back to the donor's own name/slug on collision would produce
  // "Service" / `service` here, which is the exact bug being guarded against.
  const donor = await spaceHolding(`Service-${suffix}`, 'placeholder-donor')
  await db.update(spaceApp).set({ name: 'OpenCroft', slug: 'opencroft' }).where(eq(spaceApp.id, donor.row.id))
  await getSpacesRegistry().createGraph(donor.space.slug, 'OpenCroft', 'opencroft', donor.row.id)
  const from = `${donor.space.slug}.opencroft`

  const target = await spaceHolding(`OpenCroft-${suffix}`, 'placeholder-target')
  await db.update(spaceApp).set({ name: 'Design Kit', slug: 'opencroft' }).where(eq(spaceApp.id, target.row.id))
  await getSpacesRegistry().createGraph(target.space.slug, 'Design Kit', 'opencroft', target.row.id)

  const moved = await transferSpaceAppImpl(from, target.space.slug)

  assert.equal(moved.slug, 'opencroft-2', 'own slug, numbered -- not the donor space slug ("service")')
  assert.equal(moved.name, 'OpenCroft 2', 'own name, numbered -- not the donor space name ("Service")')
})
