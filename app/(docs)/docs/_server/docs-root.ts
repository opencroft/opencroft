/**
 * Centralized docs root resolver.
 *
 * If a Documentation node exists on the graph and has a cloned repository,
 * returns the cache directory for that node.
 * Otherwise, falls back to OPENCROFT_DOCS_ROOT env var or app/docs/.
 */

import path from 'path';

const FALLBACK_DOCS_ROOT = path.join(process.cwd(), 'app', 'docs');

let cachedRoot: string | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5_000; // re-check every 5 seconds

/**
 * Get the active docs root directory.
 * Checks for a Documentation node on the graph first, then falls back.
 */
export async function getDocsRoot(): Promise<string> {
  // Check env override first (highest priority)
  const envRoot = process.env.OPENCROFT_DOCS_ROOT;
  if (envRoot) return envRoot;

  // Check cache
  const now = Date.now();
  if (cachedRoot && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedRoot;
  }

  // Try to find Documentation node's cloned repo
  try {
    const { getExtensionModule } = await import('@/app/(extension-runtime)/_server/loader');
    const mod = await getExtensionModule('builtin/core');
    const findRoot = mod.actions?.['docs.findActiveDocsRoot'];
    if (findRoot) {
      const root = await findRoot() as string | null;
      if (root) {
        cachedRoot = root;
        cacheTimestamp = now;
        return root;
      }
    }
  } catch {
    // Extension not loaded or action not available — fall through
  }

  cachedRoot = FALLBACK_DOCS_ROOT;
  cacheTimestamp = now;
  return FALLBACK_DOCS_ROOT;
}

/**
 * Synchronous version — uses cached value or fallback.
 * Use this in module-level constants where async is not possible.
 */
export function getDocsRootSync(): string {
  return cachedRoot ?? process.env.OPENCROFT_DOCS_ROOT ?? FALLBACK_DOCS_ROOT;
}

/**
 * Invalidate the cache — call after clone/pull operations.
 */
export function invalidateDocsRootCache(): void {
  cachedRoot = null;
  cacheTimestamp = 0;
}
