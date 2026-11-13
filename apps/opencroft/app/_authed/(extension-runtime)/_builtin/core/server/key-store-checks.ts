import type { GraphNodeRecord } from '@opencroft/server/graph'

import type { DeleteOutcome, NodeReference } from '../src/nodes/delete-refusal-shared'
import {
  type CheckedDeleteStore,
  DELETE_OVERRIDE_PARAM,
  type DeleteOverride,
  deleteChecked,
  nameReferences,
} from './checked-delete'

// ═══════════════════════════════════════════════════════════════════
// Key Store checks
//
// The rules every way into a Key Store applies: the inspector, the agent
// actions and a Server's `setKey`. Host-free, so they are tested without a
// database or a graph; `key-store.ts` gives them the store's keys.
// ═══════════════════════════════════════════════════════════════════

export const KEY_TYPES = ['ed25519', 'rsa', 'ecdsa'] as const
export type KeyType = (typeof KEY_TYPES)[number]

/**
 * A key's name is also a file name wherever a key is a file (its copy in WSL,
 * the store's cache directory), so it is one path segment: letters, digits,
 * `.`, `_` and `-`. It does not start with `.`, which keeps `..` out. It does
 * not end in `.pub`, the file name of another key's public half.
 */
const KEY_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/** The 255-byte file-name limit of common filesystems, less the `.pub` of the public half. */
const MAX_KEY_NAME_LENGTH = 255 - '.pub'.length

function trimmed(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** The name of a key the store may already hold. Checked against the store by the caller. */
export function requireKeyName(raw: unknown): string {
  const name = trimmed(raw)
  if (!name) {
    throw new Error('Key name is required (params.name)')
  }
  return name
}

/** The name for a key about to be written: refused, unchanged, rather than stored under another name. */
export function requireNewKeyName(raw: unknown): string {
  const name = requireKeyName(raw)
  if (!KEY_NAME.test(name) || name.endsWith('.pub') || name.length > MAX_KEY_NAME_LENGTH) {
    throw new Error(
      `Key name "${name}" is not allowed: use letters, digits, ".", "_" and "-", not starting with "." ` +
        `and not ending in ".pub", at most ${MAX_KEY_NAME_LENGTH} characters`,
    )
  }
  return name
}

/** The key type asked for; `fallback` when none is (an absent or blank value). */
export function requireKeyType(raw: unknown, fallback: KeyType = 'ed25519'): KeyType {
  const requested = trimmed(raw) || fallback
  if (!(KEY_TYPES as readonly string[]).includes(requested)) {
    throw new Error(`Unsupported key type "${requested}". Use one of: ${KEY_TYPES.join(', ')}`)
  }
  return requested as KeyType
}

/** A held key's type, as the store names it, when the store can generate that type again. */
export function regenerableKeyType(inspected: string | undefined): KeyType | undefined {
  const type = inspected?.toLowerCase()
  return KEY_TYPES.find((known) => known === type)
}

export function keyExistsError(name: string): Error {
  return new Error(`Key "${name}" already exists in this store. Delete it first, or rotate it to replace its keypair.`)
}

function absentKey(name: string): string {
  return `Key "${name}" is not in this store`
}

/** Throws unless the store holds `name`. */
export function requireHeldKey(name: string, held: string[]): void {
  if (!held.includes(name)) {
    throw new Error(absentKey(name))
  }
}

/** How a node names a key: `"<keyStoreNodeId>:<keyName>"`. */
export function keyRef(storeId: string, name: string): string {
  return `${storeId}:${name}`
}

/** Split a `"<storeId>:<name>"` reference back into its parts; null when it has no store or no name. */
export function parseKeyRef(ref: string): { storeId: string; name: string } | null {
  const idx = ref.indexOf(':')
  if (idx <= 0 || idx === ref.length - 1) {
    return null
  }
  return { storeId: ref.slice(0, idx), name: ref.slice(idx + 1) }
}

/** What `checkKeyReference` reads about the graph of the node the reference is for. */
export interface KeyStoreLookup {
  /** Whether `nodeId` is a Key Store node on that graph: the only stores whose keys the node can use. */
  isKeyStore(nodeId: string): Promise<boolean>
  /** The names the store holds. */
  listKeys(storeId: string): Promise<string[]>
}

/**
 * The lookup for a reference stored on a node whose graph holds `graphNodes`:
 * only the Key Stores among them count, as only their keys reach that node's
 * dial.
 */
export function keyStoreLookupOn(
  graphNodes: GraphNodeRecord[],
  keyStoreType: string,
  listKeys: (storeId: string) => Promise<string[]>,
): KeyStoreLookup {
  return {
    isKeyStore: async (nodeId) => graphNodes.some((node) => node.id === nodeId && node.type === keyStoreType),
    listKeys,
  }
}

/**
 * The reference, trimmed, once it names a key a Key Store holds. Throws
 * naming what is missing: the store, or the key and the keys the store does
 * hold. A reference that resolves to nothing would otherwise be stored as
 * done and fail only at the next connection.
 */
export async function checkKeyReference(raw: unknown, lookup: KeyStoreLookup): Promise<string> {
  const ref = trimmed(raw)
  if (!ref) {
    throw new Error('A key reference is required (params.key)')
  }
  const parsed = parseKeyRef(ref)
  if (!parsed) {
    throw new Error(`"${ref}" is not a key reference: expected "<keyStoreNodeId>:<keyName>"`)
  }
  if (!(await lookup.isKeyStore(parsed.storeId))) {
    throw new Error(`No Key Store node "${parsed.storeId}" on this graph`)
  }
  const held = await lookup.listKeys(parsed.storeId)
  if (!held.includes(parsed.name)) {
    const holds = held.length > 0 ? `it holds ${held.join(', ')}` : 'it holds no keys'
    throw new Error(`Key "${parsed.name}" is not in Key Store ${parsed.storeId}; ${holds}`)
  }
  return ref
}

/**
 * Whether `value` holds `wanted` as a whole string at any depth, in an object
 * whose scope is on the store's graph. An object's scope is its own
 * `credentialsScope` when it has one (a terminal context carries the node its
 * credentials come from), else the scope of the object holding it, which for
 * the node's data is the node itself. Node data is parsed JSON, so it has no
 * cycles.
 */
function holdsInScope(value: unknown, wanted: string, scope: string, onStoreGraph: ReadonlySet<string>): boolean {
  if (typeof value === 'string') {
    return value === wanted && onStoreGraph.has(scope)
  }
  if (value === null || typeof value !== 'object') {
    return false
  }
  const own = (value as { credentialsScope?: unknown }).credentialsScope
  const inner = typeof own === 'string' && own ? own : scope
  return Object.values(value).some((entry) => holdsInScope(entry, wanted, inner, onStoreGraph))
}

/**
 * Every node that holds the key's reference where it resolves, as a whole
 * value in any field: a Server's `keyPath` on the store's graph, and a copy
 * of a Server's terminal context anywhere on the instance (a router's route,
 * a Docker or Application node's resolved inputs, a `via`) whose
 * `credentialsScope` is a node on the store's graph. A copy scoped elsewhere,
 * or a node elsewhere naming the key itself, is refused at the dial
 * (`key-store-scope.ts` in the host), so deleting the key breaks nothing
 * there. A store id is a node id, unique on the instance, so the whole value
 * names this key and no other. A node that names a key some other way is not
 * seen.
 *
 * `onStoreGraph` is the ids of the nodes on the store's graph.
 */
export function findKeyReferences(
  nodes: GraphNodeRecord[],
  storeId: string,
  name: string,
  onStoreGraph: ReadonlySet<string>,
): NodeReference[] {
  const wanted = keyRef(storeId, name)
  const found: NodeReference[] = []
  for (const node of nodes) {
    const data = node.data ?? {}
    if (!holdsInScope(data, wanted, node.id, onStoreGraph)) {
      continue
    }
    const nodeName = data.name
    found.push({
      nodeId: node.id,
      nodeType: node.type,
      nodeName: typeof nodeName === 'string' && nodeName.trim() ? nodeName.trim() : undefined,
    })
  }
  return found
}

/** Why a key a node still names is not deleted, naming each of them. */
export function keyDeleteRefusal(name: string, references: NodeReference[]): string {
  const users = references.length === 1 ? '1 node still uses' : `${references.length} nodes still use`
  return (
    `Refusing to delete key "${name}": ${users} it — ${nameReferences(references)}. ` +
    `Their next SSH connection would fail. Point them at another key, or pass ${DELETE_OVERRIDE_PARAM}: true ` +
    'to delete it anyway.'
  )
}

/**
 * Deletes one key, unless a node the override does not cover still names it
 * (see `deleteChecked`). An override deletes a key that is still named,
 * leaving those references dangling.
 */
export function deleteKeyChecked(
  name: string,
  override: DeleteOverride,
  store: CheckedDeleteStore,
): Promise<DeleteOutcome> {
  return deleteChecked(name, override, store, { absent: absentKey, refused: keyDeleteRefusal })
}
