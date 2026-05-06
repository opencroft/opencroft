/**
 * Centralized docs root resolver.
 *
 * Returns the cache directory for the matching Documentation node when
 * its repo is cloned. Returns null otherwise — there is no on-disk
 * fallback; docs only exist when a Documentation node has a clone.
 *
 * `namespace` (slugified Documentation node name) selects which repo to
 * read. Omit to use the first Documentation node on the graph.
 */

let cache: Map<string, { value: string | null; at: number }> | null = null;
const CACHE_TTL_MS = 5_000;

function cacheKey(namespace: string | undefined): string {
  return namespace ?? '';
}

export async function getDocsRoot(namespace?: string): Promise<string | null> {
  const envRoot = process.env.OPENCROFT_DOCS_ROOT;
  if (envRoot) {
    return envRoot;
  }

  if (!cache) {
    cache = new Map();
  }
  const key = cacheKey(namespace);
  const now = Date.now();
  const entry = cache.get(key);
  if (entry && (now - entry.at) < CACHE_TTL_MS) {
    return entry.value;
  }

  let resolved: string | null = null;
  try {
    const { getExtensionModule } = await import('@/app/(extension-runtime)/_server/loader');
    const mod = await getExtensionModule('builtin/core');
    const findRoot = mod.actions?.['docs.findActiveDocsRoot'];
    if (findRoot) {
      const r = await findRoot({ namespace }) as string | null;
      resolved = r ?? null;
    }
  } catch {
    // Extension not loaded or action not available
  }

  cache.set(key, { value: resolved, at: now });
  return resolved;
}

export function getDocsRootSync(namespace?: string): string | null {
  const envRoot = process.env.OPENCROFT_DOCS_ROOT;
  if (envRoot) {
    return envRoot;
  }
  return cache?.get(cacheKey(namespace))?.value ?? null;
}

export function invalidateDocsRootCache(): void {
  cache = null;
}
