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

async function readStoreKey(ref: { storeId: string; name: string }): Promise<string> {
  const base = extensionsCacheDir()
  const candidates = [
    path.join(base, 'local', 'core', 'key-store', ref.storeId, ref.name),
    path.join(base, 'builtin', 'core', 'key-store', ref.storeId, ref.name),
  ]
  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, 'utf-8')
    } catch {
      /* try next */
    }
  }
  // Brute-force scan across all extension cache dirs
  try {
    const scopes = await fs.readdir(base)
    for (const scope of scopes) {
      const scopeDir = path.join(base, scope)
      const stat = await fs.stat(scopeDir).catch(() => null)
      if (!stat?.isDirectory()) {
        continue
      }
      const exts = await fs.readdir(scopeDir).catch(() => [])
      for (const ext of exts) {
        const candidate = path.join(scopeDir, ext, 'key-store', ref.storeId, ref.name)
        try {
          return await fs.readFile(candidate, 'utf-8')
        } catch {
          /* try next */
        }
      }
    }
  } catch {
    /* ignore */
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
