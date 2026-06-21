/**
 * Centralized docs root resolver.
 *
 * Returns the cache directory for the matching Documentation node when
 * its repo is cloned. Returns null otherwise — there is no on-disk
 * fallback; docs only exist when a Documentation node has a clone.
 *
 * `namespace` (slugified Documentation node name) selects which repo to
 * read. Omit to use the first Documentation node on the graph.
 *
 * The provider extension is discovered dynamically (see docs-provider): we
 * ask every extension that registers the `documentation` node type for the
 * root and return the first that resolves a cloned repo. This works no
 * matter which id the extension is installed under. The previous
 * implementation hardcoded `local/documentation`, so it silently returned
 * null — surfacing as "No documentation repository configured" — whenever
 * the extension lived under any other id, even though the node, clone, and
 * actions all worked.
 */

const FIND_ROOT_ACTION = 'docs.findActiveDocsRoot'

let cache: Map<string, { value: string | null; at: number }> | null = null
const CACHE_TTL_MS = 5_000

function cacheKey(namespace: string | undefined): string {
  return namespace ?? ''
}

/**
 * Ask each Documentation provider for the docs root and return the first
 * non-null result. A provider resolves its root against its own cache dir
 * (`host.cacheDir`), so trying every provider finds the clone wherever it
 * actually lives.
 */
async function resolveDocsRoot(namespace: string | undefined): Promise<string | null> {
  const { docProviderIds } = await import('@/app/(docs)/_server/docs-provider')
  const { getExtensionModule } = await import('@/app/(extension-runtime)/_server/loader')
  for (const extensionId of await docProviderIds()) {
    try {
      const mod = await getExtensionModule(extensionId)
      const findRoot = mod.actions?.[FIND_ROOT_ACTION]
      if (!findRoot) {
        continue
      }
      const root = (await findRoot({ namespace })) as string | null
      if (root) {
        return root
      }
    } catch {
      // Provider failed to load or threw — try the next one.
    }
  }
  return null
}

export async function getDocsRoot(namespace?: string): Promise<string | null> {
  if (!cache) {
    cache = new Map()
  }
  const key = cacheKey(namespace)
  const now = Date.now()
  const entry = cache.get(key)
  if (entry && now - entry.at < CACHE_TTL_MS) {
    return entry.value
  }

  const resolved = await resolveDocsRoot(namespace)
  cache.set(key, { value: resolved, at: now })
  return resolved
}
