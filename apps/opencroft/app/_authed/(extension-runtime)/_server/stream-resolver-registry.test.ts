// Regression coverage for a failure where group_chat_compact threw
// "No agent/job resolved for session" on a real thread with genuine membership,
// while the UI ring's Compact button (same requestCompactOnGraph([], [], key)
// call) worked. Root cause: registerStandingContextResolver/
// registerThreadDeliveryResolver only ever run once, from server/startup.ts's
// once-per-process ensureServerStarted guard. Vite's dev SSR (e.g. `vite
// dev`) can hand a later importer of this module a genuinely fresh instance —
// e.g. because some unrelated file that imports it changed — and a plain
// module-scoped array would silently start that instance's registry empty with
// nothing left to repopulate it, exactly like the group_chat_compact path did
// against the UI's already-wired instance. globalThis-backing (matching every
// other server-lifetime singleton in this app: compactJobs below, the spaces
// registry, the schedulers, the startup guard itself) is what makes the
// registry survive that, and is what this test pins.
import assert from 'node:assert/strict'
import test from 'node:test'

test('registerStandingContextResolver survives a fresh module instantiation', async () => {
  const first = await import('./stream')
  // Cache-busted specifier: forces Node's ESM loader to evaluate a genuinely
  // separate module instance, standing in for what Vite's dev SSR does when it
  // reloads this file's dependents without re-running server/startup.ts.
  const second = await import(`./stream?probe=${Math.random()}`)
  assert.notEqual(second, first, 'sanity: the cache-busted import must actually be a distinct module instance')

  const marker = async (key: string) => (key === 'resolver-probe' ? { jobContext: 'probe', instructions: [] } : null)
  first.registerStandingContextResolver(marker)

  // Registering the SAME resolver again through the fresh instance must not
  // duplicate it -- it has to be the one shared, globalThis-backed array, not
  // two independent ones that each think they're the only registry.
  second.registerStandingContextResolver(marker)
  const registry = (globalThis as unknown as { __STANDING_CONTEXT_RESOLVERS__: unknown[] })
    .__STANDING_CONTEXT_RESOLVERS__
  assert.ok(registry, 'the registry must be reachable from globalThis')
  assert.equal(registry.length, 1, 'the same resolver registered via two module instances must not duplicate')
})

test('registerThreadDeliveryResolver survives a fresh module instantiation', async () => {
  const first = await import('./stream')
  const second = await import(`./stream?probe=${Math.random()}`)
  assert.notEqual(second, first, 'sanity: the cache-busted import must actually be a distinct module instance')

  const resolver = async () => ({ status: 'not-found' as const })
  first.registerThreadDeliveryResolver(resolver)
  second.registerThreadDeliveryResolver(resolver)
  const registry = (globalThis as unknown as { __THREAD_DELIVERY_RESOLVERS__: unknown[] })
    .__THREAD_DELIVERY_RESOLVERS__
  assert.ok(registry, 'the registry must be reachable from globalThis')
  assert.equal(registry.length, 1, 'the same resolver registered via two module instances must not duplicate')
})
