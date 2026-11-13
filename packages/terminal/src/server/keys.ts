import { promises as fs } from 'node:fs'
import path from 'node:path'

// Mirrors the app's cache layout (OPENCROFT_CACHE_DIR or <cwd>/.cache).
function extensionsCacheDir(): string {
  const base = process.env.OPENCROFT_CACHE_DIR || path.join(process.cwd(), '.cache')
  return path.join(base, 'extensions')
}

interface KeyRef {
  storeId: string
  name: string
}

function parseKeyRef(keyPath?: string): KeyRef | null {
  if (!keyPath || keyPath.includes('/') || /^[A-Z]:\\/i.test(keyPath)) {
    return null
  }
  const colon = keyPath.indexOf(':')
  if (colon < 0) {
    return null
  }
  return { storeId: keyPath.slice(0, colon), name: keyPath.slice(colon + 1) }
}

/**
 * Where the host keeps Key Store keys. The host's store is the source of truth; a key it does not
 * hold may still be in a cache file, where a build without a host store keeps keys, and is copied
 * in when it is found there.
 */
export interface KeyStoreMaterial {
  /**
   * The private key `name` of store `storeId`, or null when the host holds none under that name.
   * Throws, saying why, when it holds one it cannot read.
   */
  read(storeId: string, name: string): Promise<string | null>
  /**
   * Stores `privateKey` as key `name` of store `storeId` unless the store already holds that name.
   * Answers whether it stored it.
   */
  backfill(storeId: string, name: string, privateKey: string): Promise<boolean>
}

/**
 * What the host registered: where its store keeps keys, and which nodes may use which stores.
 *
 * Kept on `globalThis`, as the session registry is (see `manager.ts`): a production build bundles
 * this package into more than one output, and the host registers on startup through one copy of
 * this module. A copy holding its own registrations would have none, and refuse every store key:
 * the terminal socket dials through a different copy than the server functions do.
 */
interface KeyStoreRegistrations {
  material: KeyStoreMaterial | null
  checkAccess: KeyStoreAccessCheck | null
}

const REGISTRATIONS_KEY = Symbol.for('opencroft.terminal.keyStoreRegistrations')

const registrationsHolder = globalThis as typeof globalThis & { [REGISTRATIONS_KEY]?: KeyStoreRegistrations }

// Until the host registers its store, keys are read from the cache files alone.
registrationsHolder[REGISTRATIONS_KEY] ??= { material: null, checkAccess: null }

const registrations: KeyStoreRegistrations = registrationsHolder[REGISTRATIONS_KEY]

/** Where Key Store keys are kept; asked before the cache files on every read of a store key. */
export function registerKeyStoreMaterial(store: KeyStoreMaterial): void {
  registrations.material = store
}

// A key's cache file is `<cache>/extensions/<extensionId>/key-store/<storeId>/<name>`,
// under the cache directory of the extension that owns the Key Store node.
// This package does not know which extension owns the node, so it looks in
// each one's `key-store` folder; a store id is a node id, so at most one of
// them holds it.
async function readCachedKey(ref: KeyRef): Promise<string | null> {
  const base = extensionsCacheDir()
  const extensionIds = await fs.readdir(base).catch(() => [])
  for (const extensionId of extensionIds.sort()) {
    try {
      return await fs.readFile(path.join(base, extensionId, 'key-store', ref.storeId, ref.name), 'utf-8')
    } catch {
      /* not in this extension's cache */
    }
  }
  return null
}

// A key read from a cache file is used whether or not it could be copied: the
// copy is how it reaches the host's store, not a condition of using it.
async function backfillQuietly(store: KeyStoreMaterial, ref: KeyRef, content: string): Promise<void> {
  try {
    await store.backfill(ref.storeId, ref.name, content)
  } catch (err) {
    console.warn(
      `[key-store] key ${ref.name} of store ${ref.storeId} was read from its cache file and not copied into the key store: ${(err as Error).message}`,
    )
  }
}

/**
 * Throws, saying why, unless the credentials whose scope is `scope` may use a
 * key from the Key Store `storeId`. The scope is opaque to this package; the
 * host passes the id of the node the credentials are stored on.
 */
export type KeyStoreAccessCheck = (storeId: string, scope: string | undefined) => Promise<void>

// This package knows where a Key Store keeps its keys, not which node may use
// which store: the host registers that rule. Until it does, no store key is read.
async function checkKeyStoreAccess(storeId: string, scope: string | undefined): Promise<void> {
  if (!registrations.checkAccess) {
    throw new Error('A key from a Key Store cannot be read: the host has not said which nodes may use which stores')
  }
  await registrations.checkAccess(storeId, scope)
}

/** How the host decides whether credentials may use a Key Store's key; checked before every read of one. */
export function registerKeyStoreAccess(check: KeyStoreAccessCheck): void {
  registrations.checkAccess = check
}

/**
 * Resolve an SSH private key. A `storeId:name` reference is read, once the
 * host's check (`registerKeyStoreAccess`) admits `scope` to that store, from
 * the host's key store (`registerKeyStoreMaterial`), and otherwise from the
 * store's cache file, which is then copied into the host's store. Anything
 * else is a filesystem path.
 */
export async function resolveKeyContent(
  keyPath: string | undefined,
  scope: string | undefined,
): Promise<string | undefined> {
  if (!keyPath) {
    return undefined
  }
  const ref = parseKeyRef(keyPath)
  if (!ref) {
    return fs.readFile(keyPath, 'utf-8')
  }
  await checkKeyStoreAccess(ref.storeId, scope)
  const { material } = registrations
  const stored = material ? await material.read(ref.storeId, ref.name) : null
  if (stored !== null) {
    return stored
  }
  const cached = await readCachedKey(ref)
  if (cached === null) {
    throw new Error(`SSH key not found: ${ref.name} (store: ${ref.storeId})`)
  }
  if (material) {
    await backfillQuietly(material, ref, cached)
  }
  return cached
}

/**
 * Deletes the cache files of the Key Stores `storeIds`, under every extension's cache.
 * `copyCachedKeys` copies whatever is there into the host's store at every start, so a store
 * whose keys are deleted loses its files first, or the next start brings the keys back. Only
 * store directories listed there are removed, so an id reaches no path outside them.
 */
export async function removeCachedKeyStores(storeIds: Iterable<string>): Promise<void> {
  const removing = new Set(storeIds)
  const base = extensionsCacheDir()
  for (const extensionId of await fs.readdir(base).catch(() => [])) {
    const storesDir = path.join(base, extensionId, 'key-store')
    for (const storeId of await fs.readdir(storesDir).catch(() => [])) {
      if (removing.has(storeId)) {
        await fs.rm(path.join(storesDir, storeId), { recursive: true, force: true })
      }
    }
  }
}

/** What `copyCachedKeys` did: keys stored now, keys the store already held, and keys it could not store. */
export interface CachedKeysCopy {
  copied: number
  present: number
  failed: number
}

function isPrivateKeyText(content: string): boolean {
  return content.includes('PRIVATE KEY') || content.includes('-----BEGIN')
}

/**
 * Copies every private key in a Key Store cache directory into the host's key
 * store, leaving the files as they are. A key the store already holds keeps
 * the store's copy. Only the stores `isLive` admits are copied: the files of a
 * store whose node is gone stay where they are and stay out of the host's
 * store, which cannot delete them with the node once they are copied. Throws
 * only when no store is registered.
 */
export async function copyCachedKeys(isLive: (storeId: string) => boolean): Promise<CachedKeysCopy> {
  const { material } = registrations
  if (!material) {
    throw new Error('Cached keys cannot be copied: the host has not registered a key store')
  }
  const result: CachedKeysCopy = { copied: 0, present: 0, failed: 0 }
  const base = extensionsCacheDir()
  for (const extensionId of (await fs.readdir(base).catch(() => [])).sort()) {
    const storesDir = path.join(base, extensionId, 'key-store')
    for (const storeId of await fs.readdir(storesDir).catch(() => [])) {
      if (!isLive(storeId)) {
        continue
      }
      const storeDir = path.join(storesDir, storeId)
      for (const name of await fs.readdir(storeDir).catch(() => [])) {
        // `.pub` is a key's public half; a dot-name is a rotation's staging.
        if (name.endsWith('.pub') || name.startsWith('.')) {
          continue
        }
        const content = await fs.readFile(path.join(storeDir, name), 'utf-8').catch(() => null)
        if (content === null || !isPrivateKeyText(content)) {
          continue
        }
        try {
          if (await material.backfill(storeId, name, content)) {
            result.copied += 1
          } else {
            result.present += 1
          }
        } catch (err) {
          result.failed += 1
          console.warn(
            `[key-store] key ${name} of store ${storeId} could not be copied into the key store: ${(err as Error).message}`,
          )
        }
      }
    }
  }
  return result
}
