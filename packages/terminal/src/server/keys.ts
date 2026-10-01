import { promises as fs } from 'node:fs'
import path from 'node:path'

// Mirrors the app's cache layout (OPENCROFT_CACHE_DIR or <cwd>/.cache).
function extensionsCacheDir(): string {
  const base = process.env.OPENCROFT_CACHE_DIR || path.join(process.cwd(), '.cache')
  return path.join(base, 'extensions')
}

function parseKeyRef(keyPath?: string): { storeId: string; name: string } | null {
  if (!keyPath || keyPath.includes('/') || /^[A-Z]:\\/i.test(keyPath)) {
    return null
  }
  const colon = keyPath.indexOf(':')
  if (colon < 0) {
    return null
  }
  return { storeId: keyPath.slice(0, colon), name: keyPath.slice(colon + 1) }
}

// A Key Store node writes its keys under its extension's cache directory, which
// is `<cache>/extensions/<extensionId>/`. This package does not know which
// extension owns the node, so it looks in each one's `key-store` folder; a
// store id is a node id, so at most one of them holds it.
async function readStoreKey(ref: { storeId: string; name: string }): Promise<string> {
  const base = extensionsCacheDir()
  const extensionIds = await fs.readdir(base).catch(() => [])
  for (const extensionId of extensionIds.sort()) {
    try {
      return await fs.readFile(path.join(base, extensionId, 'key-store', ref.storeId, ref.name), 'utf-8')
    } catch {
      /* not in this extension's cache */
    }
  }
  throw new Error(`SSH key not found: ${ref.name} (store: ${ref.storeId})`)
}

/**
 * Resolve an SSH private key. A `storeId:name` reference reads from a Key Store
 * node's cache; anything else is a filesystem path.
 */
export async function resolveKeyContent(keyPath?: string): Promise<string | undefined> {
  if (!keyPath) {
    return undefined
  }
  const ref = parseKeyRef(keyPath)
  if (ref) {
    return readStoreKey(ref)
  }
  return fs.readFile(keyPath, 'utf-8')
}
