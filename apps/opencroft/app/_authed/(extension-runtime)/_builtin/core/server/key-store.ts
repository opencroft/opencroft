import { extensionId } from '@opencroft/server/extension'
import { graph } from '@opencroft/server/graph'
import { cacheDir } from '@opencroft/server/storage'
import { exec, fs, os, path } from '@opencroft/server/system'
import { type SshKeyRecord, ssh } from '@opencroft/server/terminal'
import { generateSshKey } from '@opencroft/terminal/server'

import type { DeleteOutcome, NodeReference } from '../src/nodes/delete-refusal-shared'
import { storedType } from '../src/nodes/stored-type'
import type { DeleteOverride } from './checked-delete'
import { syncKeyIndex } from './key-index'
import {
  deleteKeyChecked,
  findKeyReferences,
  type KeyType,
  keyExistsError,
  keyRef,
  regenerableKeyType,
  requireHeldKey,
  requireKeyName,
  requireKeyType,
  requireNewKeyName,
} from './key-store-checks'
import { turnsPerKey } from './turns-per-key'

// ═══════════════════════════════════════════════════════════════════
// Key Store
//
// Keys are kept by the host (`ssh.keys`), in its database with the private
// half encrypted. Only ever expose key *metadata* (name/type/fingerprint) and
// *public* keys — private key material must never be returned to callers
// (e.g. agents driving node actions).
// ═══════════════════════════════════════════════════════════════════

const isWindows = os.platform() === 'win32'

export const KEY_STORE_TYPE = storedType(extensionId, 'core-key-store')

export interface KeyEntry {
  name: string
  type: string
  fingerprint: string
  hasPublicKey: boolean
  inWsl: boolean
}

/** A key just written, as callers see it: no private material. */
export interface KeyCreated {
  name: string
  keyType: KeyType
  fingerprint: string
}

/** A key just imported: its type as read from the key, which may be one the store cannot generate. */
export interface KeyImported {
  name: string
  type: string
  fingerprint: string
}

export interface KeyRotated extends KeyCreated {
  /** The new public half, to install where the old one was. */
  publicKey: string
  /** The nodes that name the key: they connect with the new keypair from now on. */
  usedBy: NodeReference[]
}

/**
 * A key's file in this store's cache directory, where a build without the
 * host's key store keeps it. The host copies such files into its database and
 * leaves them (see `copyCachedKeys` in `@opencroft/terminal`); a key replaced
 * or deleted here loses its file too, so the old material is not copied back.
 */
function cachedKeyPath(storeId: string, name: string): string {
  return path.join(cacheDir('key-store', storeId), name)
}

async function removeCachedKey(storeId: string, name: string): Promise<void> {
  const keyPath = cachedKeyPath(storeId, name)
  await fs.rm(keyPath, { force: true })
  await fs.rm(`${keyPath}.pub`, { force: true })
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** `~/.ssh/keys/<name>` for a shell command: the home expands, the name stays literal. */
function wslKeyPath(name: string): string {
  return `~/.ssh/keys/${shellSingleQuote(name)}`
}

async function isKeyInWsl(name: string): Promise<boolean> {
  try {
    await exec(`test -f ${wslKeyPath(name)}`)
    return true
  } catch {
    return false
  }
}

async function entryOf(key: SshKeyRecord): Promise<KeyEntry> {
  return {
    name: key.name,
    type: key.type,
    fingerprint: key.fingerprint,
    hasPublicKey: key.publicKey !== null,
    inWsl: isWindows ? await isKeyInWsl(key.name) : false,
  }
}

export async function keyStoreListKeys(storeId: string): Promise<KeyEntry[]> {
  return Promise.all((await ssh.keys.list(storeId)).map(entryOf))
}

/** The names of the keys the store holds, as the list shows them. */
export async function keyStoreKeyNames(storeId: string): Promise<string[]> {
  return (await ssh.keys.list(storeId)).map((key) => key.name)
}

/**
 * Brings the store node's `keyNames` to the keys the store holds (see
 * `key-index.ts`). Called after a key is written, so a failure is logged and
 * does not fail the write: the card keeps its old list until the store's keys
 * are next written or read.
 */
async function updateKeyIndex(storeId: string): Promise<void> {
  try {
    await syncKeyIndex(storeId, { listNames: keyStoreKeyNames, graph, storeType: KEY_STORE_TYPE })
  } catch (err) {
    console.error(`[key-store] the key list of store ${storeId} could not be updated`, err)
  }
}

/** The store's keys, as its inspector and the `list` action show them; the node's `keyNames` is brought to them first. */
export async function keyStoreShowKeys(storeId: string): Promise<KeyEntry[]> {
  await updateKeyIndex(storeId)
  return keyStoreListKeys(storeId)
}

/** Generates a keypair under a new name; a name the store already has is refused, never replaced. */
export async function keyStoreCreateKey(storeId: string, rawName: unknown, rawType: unknown): Promise<KeyCreated> {
  const name = requireNewKeyName(rawName)
  const keyType = requireKeyType(rawType)
  const key = generateSshKey(keyType, name)
  if (!(await ssh.keys.put(storeId, name, key, 'create'))) {
    throw keyExistsError(name)
  }
  await updateKeyIndex(storeId)
  return { name, keyType, fingerprint: key.fingerprint }
}

/**
 * Stores an existing private key under a new name; a name the store already
 * has is refused, never replaced. Answers with the key's metadata, never the
 * key.
 */
export async function keyStoreImportKey(storeId: string, rawName: unknown, content: unknown): Promise<KeyImported> {
  const name = requireNewKeyName(rawName)
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('The private key is required (params.privateKey)')
  }
  if (!(await ssh.keys.put(storeId, name, { privateKey: content }, 'create'))) {
    throw keyExistsError(name)
  }
  await updateKeyIndex(storeId)
  const stored = await ssh.keys.get(storeId, name)
  return { name, type: stored?.type ?? 'unknown', fingerprint: stored?.fingerprint ?? '' }
}

/**
 * The nodes on the instance that use this store's key where it resolves:
 * those whose reference is scoped to a node on the store's graph (see
 * `findKeyReferences`), routed copies on other graphs included.
 */
export async function keyStoreReferences(storeId: string, rawName: unknown): Promise<NodeReference[]> {
  const onStoreGraph = new Set((await graph.listGraphNodes(storeId)).map((node) => node.id))
  return findKeyReferences(await graph.listNodes(), storeId, requireKeyName(rawName), onStoreGraph)
}

// A rotation and a delete of one key, or two rotations, each check and write
// without the other in between. In-process only: two servers sharing the
// database are not ordered against each other, and each write is still one
// statement, so the row is never half replaced.
const keyTurns = turnsPerKey()

function inKeyTurn<T>(storeId: string, name: string, change: () => Promise<T>): Promise<T> {
  return keyTurns(keyRef(storeId, name), change)
}

async function requireStoredKey(storeId: string, name: string): Promise<SshKeyRecord> {
  const stored = await ssh.keys.get(storeId, name)
  requireHeldKey(name, stored ? [name] : [])
  return stored as SshKeyRecord
}

/**
 * Replaces a held key's keypair under the same name in one write, so
 * references to it stay valid. The new pair has the key's current type unless
 * another is asked for.
 */
export async function keyStoreRotateKey(storeId: string, rawName: unknown, rawType?: unknown): Promise<KeyRotated> {
  const name = requireKeyName(rawName)
  const rotated = await inKeyTurn(storeId, name, async () => {
    const current = await requireStoredKey(storeId, name)
    const keyType = requireKeyType(rawType, regenerableKeyType(current.type))
    const key = generateSshKey(keyType, name)
    // Deleted by another server since the check: refused, as the check would have.
    requireHeldKey(name, (await ssh.keys.put(storeId, name, key, 'replace')) ? [name] : [])
    await removeCachedKey(storeId, name)
    return { name, keyType, fingerprint: key.fingerprint, publicKey: key.publicKey }
  })
  await updateKeyIndex(storeId)
  return { ...rotated, usedBy: await keyStoreReferences(storeId, name) }
}

/** Deletes a held key unless a node the override does not cover names it (see `deleteKeyChecked`). */
export async function keyStoreDeleteKey(
  storeId: string,
  rawName: unknown,
  override: DeleteOverride = false,
): Promise<DeleteOutcome> {
  const name = requireKeyName(rawName)
  const outcome = await inKeyTurn(storeId, name, () =>
    deleteKeyChecked(name, override, {
      listKeys: () => keyStoreKeyNames(storeId),
      listReferences: () => keyStoreReferences(storeId, name),
      // The file goes first: a resolve that finds no row reads the file and
      // copies it back into the database, so a file left after the row would
      // bring the deleted key back.
      remove: async () => {
        await removeCachedKey(storeId, name)
        await ssh.keys.delete(storeId, name)
      },
    }),
  )
  await updateKeyIndex(storeId)
  return outcome
}

export async function keyStoreReadPublicKey(storeId: string, rawName: unknown): Promise<string> {
  const name = requireKeyName(rawName)
  const { publicKey } = await requireStoredKey(storeId, name)
  if (publicKey === null) {
    throw new Error(`Key "${name}" has no public half: its private key could not be read to derive one`)
  }
  return publicKey
}

/** Whether this host has WSL to copy keys into: only a Windows host does. */
export function keyStoreHasWsl(): boolean {
  return isWindows
}

function requireWsl(): void {
  if (!isWindows) {
    throw new Error('Copying a key to WSL needs a Windows host; this one is not')
  }
}

export async function keyStoreCopyKeyToWsl(storeId: string, rawName: unknown): Promise<void> {
  requireWsl()
  const name = requireKeyName(rawName)
  const { publicKey } = await requireStoredKey(storeId, name)
  // The store is on its own graph, so it is the scope that admits its keys.
  const content = await ssh.resolveKey(keyRef(storeId, name), { nodeId: storeId })
  await exec('mkdir -p ~/.ssh/keys')
  await exec(`cat > ${wslKeyPath(name)} << 'KEYEOF'\n${content}\nKEYEOF`)
  await exec(`chmod 600 ${wslKeyPath(name)}`)
  if (publicKey !== null) {
    await exec(`cat > ${wslKeyPath(`${name}.pub`)} << 'KEYEOF'\n${publicKey}\nKEYEOF`)
  }
}

export async function keyStoreRemoveKeyFromWsl(rawName: unknown): Promise<void> {
  requireWsl()
  const name = requireKeyName(rawName)
  await exec(`rm -f ${wslKeyPath(name)} ${wslKeyPath(`${name}.pub`)}`)
}
