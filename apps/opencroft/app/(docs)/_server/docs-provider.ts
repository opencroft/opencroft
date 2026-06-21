/**
 * Documentation provider resolution.
 *
 * The documentation feature is implemented by an extension that registers
 * the `documentation` node type and exposes `docs.*` server actions. That
 * extension can be installed under any id — `local/documentation` for a dev
 * copy, `installed/<slug>` from a registry, a renamed fork, … — and stores
 * its clones under its own `host.cacheDir`. Core must therefore locate it by
 * the capability it provides (the node type), never by a hardcoded id.
 *
 * Every core call site that used to do `getExtensionModule('local/documentation')`
 * now goes through here, so the docs page and the MCP doc tools keep working
 * regardless of the provider's install id.
 */

import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader'

const DOC_NODE_TYPE = 'documentation'

/** Ids of every installed extension that provides the Documentation node type. */
export async function docProviderIds(): Promise<string[]> {
  // Dynamic import keeps the extension loader off this module's eval-time
  // dependency graph — docs-provider is pulled in by several server
  // entrypoints, and the loader transitively imports a lot.
  const { loadAllManifests } = await import('@/app/(extension-runtime)/_server/loader')
  const manifests = await loadAllManifests()
  return manifests.filter((m) => m.nodes?.some((n) => n.typeId === DOC_NODE_TYPE)).map((m) => m.id)
}

/**
 * Call a `docs.*` action on the Documentation provider that exposes it.
 *
 * Providers are tried in registry order; the first one that defines the
 * action handles the call and its result is returned. Returns `null` when no
 * installed provider exposes the action. Errors thrown by the action handler
 * itself propagate to the caller (callers decide whether to swallow them).
 */
export async function callDocsAction<T = unknown>(
  action: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  for (const extensionId of await docProviderIds()) {
    let fn: ((p: Record<string, unknown>) => unknown) | undefined
    try {
      const mod = await getExtensionModule(extensionId)
      fn = mod.actions?.[action] as typeof fn
    } catch {
      // Provider failed to load — try the next one.
      continue
    }
    if (fn) {
      return (await fn(params)) as T
    }
  }
  return null
}
