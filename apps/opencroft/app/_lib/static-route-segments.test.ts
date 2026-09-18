// A static route segment must never be a string a user's NAME could mint.
//
// The defect class, found the hard way: `/space/<space>/
// settings/app/add` was a static sibling of `$app`, which carries an instance
// slug. Once app addresses became slugs the two shared one namespace, so an app
// named "Add" minted the slug `add`, the static route outranked the dynamic one,
// and that app's own settings link opened the add-app form instead. No error, no
// 404, wrong screen.
//
// Nothing about that is specific to the word "add", which is why reserving it
// was rejected as the fix: the namespace stays shared and the next collision is
// found the same way this one was, by a person tripping over it. This test is
// the durable half. A segment is MINTABLE exactly when `instanceSlugFor` maps it
// to itself -- slugify is idempotent on its own outputs, so a fixed point is a
// reachable slug -- and every static sibling of a slug-carrying dynamic segment
// must fail that test.
//
// Both grammars here are the real ones. The slug grammar is the imported
// `instanceSlugFor`, never a restated regex, so there is one definition of what
// a name can mint. The route grammar is the generator's own output: the keys of
// `FileRoutesByFullPath` are URL paths IT computed, so groups, `_` suffixes and
// index tokens are applied by the code that owns those conventions rather than
// re-derived from filenames here.
//
// THREE PINS, because there are three ways a check like this reports green
// without checking anything: the population could be empty (cardinality), the
// predicate could be unable to fail (positive control), and a recorded
// exemption could outlive the defect it excuses (the second direction below).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { instanceSlugFor } from '@/app/_authed/(space)/_server/slug'

// Generated, gitignored, and present in any checkout that can build or
// typecheck -- so reading it is not a dependency on someone having remembered
// to do something.
const GENERATED_ROUTE_TREE = join(import.meta.dirname, '..', 'routeTree.gen.ts')

/**
 * Dynamic segments that hold an OPAQUE id rather than a user-minted slug.
 * Nobody names these, so a static sibling of one is not reachable by naming
 * anything, and the rule below does not apply to it.
 *
 * LISTED THIS WAY ROUND ON PURPOSE. The obvious spelling is a list of the
 * slug-carrying params instead -- and it fails open: a route that starts
 * addressing something by a user-chosen slug drops silently out of the
 * population, and the guard keeps reporting green over a set that no longer
 * includes the thing it should be watching. Inverted, the default is guarded:
 * an unclassified new param is treated as slug-carrying, so forgetting to
 * classify one trips this file as a loud false positive. A false positive costs
 * somebody a minute; the other direction costs a silent wrong screen, which is
 * the exact defect this file exists for.
 */
const OPAQUE_ID_PARAMS = new Set(['$', '$userId', '$groupChatId', '$threadId', '$filename'])

function carriesSlug(segment: string): boolean {
  return segment.startsWith('$') && !OPAQUE_ID_PARAMS.has(segment)
}

/** A static sibling this tree is known to have, so an enumerator that finds nothing cannot pass. */
const KNOWN_SIBLING = '/space/$slug/settings/app/~add'

/**
 * Collisions that exist and are NOT being fixed here, each with what it shadows.
 * Checked in both directions: nothing may join this list silently, and an entry
 * whose defect gets fixed makes this file red until the entry is struck off. An
 * exemption that can outlive its cause is just a hole.
 */
const EXPECTED_COLLISIONS = [
  {
    segment: '/api/spaces/active',
    shadows: '/api/spaces/$slug',
    // PUT /api/spaces/active switches which space is active; PUT on the dynamic
    // sibling saves that space's graph. A space named "Active" mints the slug
    // `active`, so its graph-save is silently rerouted into an active-space
    // switch. Predates slug addresses for apps -- space slugs have been mintable and in
    // URLs all along -- and repairing it needs its own diff and its own control
    // (a space named "Active": GET returns its graph, PUT saves its graph).
    tracked: 'a separate fix',
  },
]

function generatedUrlPaths(): string[] {
  const source = readFileSync(GENERATED_ROUTE_TREE, 'utf8')
  const block = source.match(/export interface FileRoutesByFullPath \{\n([\s\S]*?)\n\}/)
  assert.ok(block, 'the generated route tree still declares FileRoutesByFullPath')
  const paths = [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1])
  assert.ok(paths.length > 20, `expected the whole route tree, read ${paths.length} paths`)
  return paths
}

/** Every static segment sitting where a user-minted slug can also appear — the population the rule runs over. */
function staticSiblingsOfSlugSegments(paths: string[]): string[] {
  const childrenByParent = new Map<string, Set<string>>()
  for (const path of paths) {
    const segments = path.split('/').filter((segment) => segment.length > 0)
    for (let i = 0; i < segments.length; i++) {
      const parent = segments.slice(0, i).join('/')
      const siblings = childrenByParent.get(parent) ?? new Set<string>()
      siblings.add(segments[i])
      childrenByParent.set(parent, siblings)
    }
  }
  const found: string[] = []
  for (const [parent, siblings] of childrenByParent) {
    if (![...siblings].some(carriesSlug)) {
      continue
    }
    for (const segment of siblings) {
      if (!segment.startsWith('$')) {
        found.push(`/${parent}/${segment}`)
      }
    }
  }
  return found.sort()
}

/** A segment a name can produce: slugify is idempotent on its own outputs, so a fixed point is reachable. */
function isMintable(path: string): boolean {
  const segment = path.slice(path.lastIndexOf('/') + 1)
  return instanceSlugFor(segment) === segment
}

// PIN 1 — CARDINALITY. Every assertion below is quantified over this population,
// and a walk that silently found nothing (wrong path, moved directory, changed
// route-tree shape) would satisfy all of them vacuously and report green over
// zero routes. So require it to have found the sibling we know is there.
test('CARDINALITY: the walk finds the static siblings it is supposed to be checking', () => {
  const population = staticSiblingsOfSlugSegments(generatedUrlPaths())
  assert.ok(population.length > 0, 'the walk found no static siblings at all, so it checked nothing')
  assert.ok(
    population.includes(KNOWN_SIBLING),
    `the walk did not find ${KNOWN_SIBLING}, which this tree definitely has: ${JSON.stringify(population)}`,
  )
})

// PIN 2 — THE RULE.
test('no static route segment can be minted from a name', () => {
  const collisions = staticSiblingsOfSlugSegments(generatedUrlPaths()).filter(isMintable)
  assert.deepEqual(
    collisions,
    EXPECTED_COLLISIONS.map((entry) => entry.segment).sort(),
    'a static sibling of a slug segment is reachable by naming something after it',
  )
})

// PIN 2, second direction. Without this an exemption is permanent: the defect
// gets fixed, the entry stays, and the next real collision at that address is
// waved through by a line nobody remembers writing.
test('every recorded collision is still a real one', () => {
  const paths = generatedUrlPaths()
  const population = staticSiblingsOfSlugSegments(paths)
  for (const entry of EXPECTED_COLLISIONS) {
    assert.ok(
      population.includes(entry.segment),
      `${entry.segment} is recorded as a known collision but is no longer a static sibling — strike it off`,
    )
    assert.ok(isMintable(entry.segment), `${entry.segment} is recorded as mintable but no longer is — strike it off`)
    assert.ok(
      paths.includes(entry.shadows),
      `${entry.segment} is recorded as shadowing ${entry.shadows}, which is not in the route tree`,
    )
  }
})

// PIN 3 — POSITIVE CONTROL. The rule above asserts an absence, and an absence
// passes just as happily when the predicate cannot detect anything at all. Feed
// it the exact tree that would otherwise have shipped and require it to object.
test('CONTROL: the check catches a mintable sibling when there is one', () => {
  const wouldHaveShipped = ['/space/$slug/app/$app', '/space/$slug/settings/app/$app', '/space/$slug/settings/app/add']
  assert.deepEqual(staticSiblingsOfSlugSegments(wouldHaveShipped).filter(isMintable), ['/space/$slug/settings/app/add'])
  assert.equal(isMintable('/space/$slug/settings/app/add'), true, 'the old segment was mintable — that was the defect')
})

// The failure DIRECTION, which is the only reason for listing opaque ids rather
// than slug ones. This is a route family that does not exist yet, carrying a
// param nobody has classified, beside a static sibling a name could mint — and
// the check objects to it without anyone having remembered to add anything.
// Listed the other way round it would have said nothing at all.
test('CONTROL: a param nobody has classified is guarded by default, not skipped', () => {
  const routesNobodyHasClassifiedYet = ['/widgets/$widgetSlug', '/widgets/new']
  assert.deepEqual(staticSiblingsOfSlugSegments(routesNobodyHasClassifiedYet).filter(isMintable), ['/widgets/new'])
})

// And the other half of the positive control: quiet about the tree as it
// actually ships, or the tests above would prove only that it objects to
// everything.
test('CONTROL: the check is silent on the segment that replaced it', () => {
  const shipping = ['/space/$slug/app/$app', '/space/$slug/settings/app/$app', KNOWN_SIBLING]
  assert.deepEqual(staticSiblingsOfSlugSegments(shipping).filter(isMintable), [])
  assert.equal(isMintable(KNOWN_SIBLING), false, '`~add` is safe because no name mints it, not because it looks odd')
})

// Requirement: the old address is not kept alive anywhere. It
// now falls through to `$app` as the slug `add`, which resolves only if an app
// is actually named "Add" and otherwise 404s — correct dead-address behaviour
// under the no-alias rule, and a redirect here would break it.
test('the old add address is gone from the route tree, with nothing left behind', () => {
  const paths = generatedUrlPaths()
  assert.ok(paths.includes(KNOWN_SIBLING), 'the form has a new address')
  assert.ok(!paths.includes('/space/$slug/settings/app/add'), 'and the old one is not also mounted')
})
