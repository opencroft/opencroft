import { db, secret, spaceApp } from '@opencroft/db'
import type {
  GraphNodeRecord,
  HostSecretsApi,
  SecretRecipe,
  SecretRecord,
  SecretReference,
  SecretScope,
} from '@opencroft/server'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import { parseType } from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  type AppSecretHolder,
  findAppSecretReferences,
  findSecretReferences,
  type SecretKeyReferences,
} from '@/app/_authed/(secrets-store)/_lib/secret-references'
import { secretNameOf } from '@/app/_authed/(secrets-store)/_lib/secret-values'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { canDecrypt, decrypt, encrypt } from '@/server/crypto'

type Row = typeof secret.$inferSelect

const TYPED: SecretRecipe = { kind: 'typed' }

// Only this module writes the column, always from a `SecretRecipe`; a value that does not parse is
// read as no recipe, like a row whose column is null.
function parseRecipe(text: string | null): SecretRecipe | null {
  if (!text) {
    return null
  }
  try {
    const parsed = JSON.parse(text) as { kind?: unknown } | null
    return typeof parsed?.kind === 'string' ? (parsed as SecretRecipe) : null
  } catch {
    return null
  }
}

function toRecord(row: Row): SecretRecord {
  return {
    id: row.id,
    storeId: row.storeId,
    key: row.key,
    value: decrypt(row.value),
    recipe: parseRecipe(row.recipe),
    updatedAt: row.updatedAt,
  }
}

/** The Secrets Store nodes in `scope`, whose ids key their rows, and the scope as an error names it. */
interface ScopeStores {
  storeIds: string[]
  where: string
}

// The same nodes the inspector's pickers read their names from: a Secrets Store's rows are keyed by
// the id of its node, so a row is in scope exactly when its node is.
export function storeIdsOn(graphs: GraphData[]): string[] {
  const ids: string[] = []
  for (const graph of graphs) {
    for (const node of graph.nodes as { id?: unknown; type?: unknown }[]) {
      if (typeof node.id === 'string' && parseType(String(node.type ?? ''))?.bare === 'core-secrets-store') {
        ids.push(node.id)
      }
    }
  }
  return ids
}

async function storesIn(scope: SecretScope | undefined): Promise<ScopeStores> {
  // Checked at run time too: an extension compiled against an older `@opencroft/server` calls
  // without a scope, and is refused rather than given a store from anywhere.
  const given = (scope ?? {}) as { nodeId?: unknown; spaceSlug?: unknown }
  const nodeId = typeof given.nodeId === 'string' && given.nodeId ? given.nodeId : undefined
  const spaceSlug = typeof given.spaceSlug === 'string' && given.spaceSlug ? given.spaceSlug : undefined
  if (!nodeId && !spaceSlug) {
    throw new Error('A secret resolves within a graph or a space: pass the node or the space that names it')
  }
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  if (nodeId) {
    const ref = registry.findByNode(nodeId)
    if (!ref) {
      throw new Error(`Node ${nodeId} is on no graph, so no Secrets Store can hold its secrets`)
    }
    return { storeIds: storeIdsOn([ref.graph.graph]), where: `on graph ${registry.addressOf(ref)}` }
  }
  // Set: the check above lets through only a call that gives one of the two.
  const space = registry.getBySlug(spaceSlug as string)
  if (!space) {
    throw new Error(`Space ${spaceSlug} not found, so no Secrets Store can hold its secrets`)
  }
  return {
    storeIds: storeIdsOn([...space.graphs.values()].map((g) => g.graph)),
    where: `in space ${space.slug}`,
  }
}

/** What could resolve a name from one store: the nodes and Apps whose scope holds it. */
interface StoreConsumers {
  nodes: GraphNodeRecord[]
  apps: AppSecretHolder[]
}

/**
 * The reverse of `storesIn`: a node resolves from the stores on its own graph and an App from the
 * stores on every graph of its space, so a store is resolved from by the nodes on its graph and
 * the Apps of its space. A store on no graph (an orphan's rows) is in no scope.
 */
async function consumersOf(storeId: string): Promise<StoreConsumers> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const ref = registry.findByNode(storeId)
  if (!ref) {
    return { nodes: [], apps: [] }
  }
  const rows = await db.query.spaceApp.findMany({
    columns: { type: true, name: true, slug: true, params: true },
    where: eq(spaceApp.spaceId, ref.space.id),
  })
  return {
    nodes: ref.graph.graph.nodes as unknown as GraphNodeRecord[],
    apps: rows.map((row) => ({
      address: `${ref.space.slug}.${row.slug}`,
      type: row.type,
      name: row.name,
      params: JSON.parse(row.params) as Record<string, string>,
    })),
  }
}

function referencesIn(consumers: StoreConsumers, key: string): SecretReference[] {
  return [...findSecretReferences(consumers.nodes, key), ...findAppSecretReferences(consumers.apps, key)]
}

async function findInStores(key: string, storeIds: string[]): Promise<string | null> {
  if (storeIds.length === 0) {
    return null
  }
  const row = await db.query.secret.findFirst({
    where: and(eq(secret.key, key), inArray(secret.storeId, storeIds)),
    orderBy: asc(secret.createdAt),
  })
  return row ? decrypt(row.value) : null
}

/** Extends the extension-facing {@link HostSecretsApi} with store-level operations used by the app. */
interface SecretsService extends HostSecretsApi {
  /**
   * Resolve a secret value by key across every store on the instance (oldest match wins); null if
   * absent. Only for the agent-facing `secrets: [...]` parameter of the `remote_*` tools, whose
   * documented rule is any Secrets Store: everything a node or an App names resolves with a scope.
   */
  resolveOnInstance(key: string): Promise<string | null>
  /**
   * The names `resolve` finds within `scope`, sorted and each once, for a picker that offers them.
   * Never decrypts, so no value exists on any path that starts here.
   */
  namesIn(scope: SecretScope): Promise<string[]>
  /**
   * For each name the stores hold, the nodes and Apps that would resolve it from one of them and
   * name it (as `references`), leaving out `removing`: nodes deleted together with the stores
   * break with nothing. Only names something still names are listed, and each node or App once.
   */
  referencesToStores(storeIds: string[], removing?: Iterable<string>): Promise<SecretKeyReferences[]>
  deleteStore(storeId: string): Promise<void>
  listStores(): Promise<{ storeId: string; keys: string[] }[]>
  /** How many stored secrets the instance's OPENCROFT_SECRETS_KEY cannot decrypt, such as ones restored from another instance. */
  countUndecryptable(): Promise<number>
  /**
   * Every stored value the instance's key can decrypt, across all stores. A row it cannot decrypt
   * is left out rather than failing the call: nothing on this instance can resolve that row to a
   * value either, so no reader of this list can meet it in clear.
   */
  listDecryptableValues(): Promise<string[]>
  /**
   * Called with a store's id after every write that adds, removes or replaces one of its rows,
   * once the write is stored. A write resolves after its listeners do, so whatever they derive
   * from the store is in place when the caller goes on. A listener that throws is logged and does
   * not fail the write: the row is already stored.
   */
  onStoreChanged(listener: (storeId: string) => Promise<void>): void
}

const storeChangedListeners: Array<(storeId: string) => Promise<void>> = []

async function storeChanged(storeId: string): Promise<void> {
  for (const listener of storeChangedListeners) {
    try {
      await listener(storeId)
    } catch (err) {
      console.error(`[secrets] a listener failed after a write to store ${storeId}`, err)
    }
  }
}

export const secrets: SecretsService = {
  async resolve(key, scope) {
    return findInStores(key, (await storesIn(scope)).storeIds)
  },
  async resolveValue(value, scope) {
    const name = secretNameOf(value)
    if (name === undefined) {
      return value
    }
    const { storeIds, where } = await storesIn(scope)
    const resolved = name ? await findInStores(name, storeIds) : null
    if (resolved === null) {
      throw new Error(`Secret "${name}" not found in any Secrets Store ${where}`)
    }
    return resolved
  },
  async resolveOnInstance(key) {
    const row = await db.query.secret.findFirst({ where: eq(secret.key, key), orderBy: asc(secret.createdAt) })
    return row ? decrypt(row.value) : null
  },
  async namesIn(scope) {
    const { storeIds } = await storesIn(scope)
    if (storeIds.length === 0) {
      return []
    }
    const rows = await db.query.secret.findMany({ columns: { key: true }, where: inArray(secret.storeId, storeIds) })
    return [...new Set(rows.map((r) => r.key))].sort()
  },
  async references(storeId, key) {
    return referencesIn(await consumersOf(storeId), key)
  },
  async referencesToStores(storeIds, removing = []) {
    const gone = new Set(removing)
    const byKey = new Map<string, Map<string, SecretReference>>()
    for (const storeId of storeIds) {
      const [keys, consumers] = await Promise.all([secrets.listKeys(storeId), consumersOf(storeId)])
      for (const key of keys) {
        const found = byKey.get(key) ?? new Map<string, SecretReference>()
        for (const ref of referencesIn(consumers, key)) {
          if (!gone.has(ref.nodeId)) {
            found.set(ref.nodeId, ref)
          }
        }
        byKey.set(key, found)
      }
    }
    return [...byKey]
      .filter(([, found]) => found.size > 0)
      .map(([key, found]) => ({ key, references: [...found.values()] }))
  },
  async get(storeId, key) {
    const row = await db.query.secret.findFirst({ where: and(eq(secret.storeId, storeId), eq(secret.key, key)) })
    return row ? decrypt(row.value) : null
  },
  async list(storeId) {
    const rows = await db.query.secret.findMany({ where: eq(secret.storeId, storeId), orderBy: asc(secret.createdAt) })
    return rows.map(toRecord)
  },
  async listKeys(storeId) {
    // Columns, not `toRecord`: nothing here decrypts, so no value exists to
    // leak on any path that starts from this call.
    const rows = await db.query.secret.findMany({
      columns: { key: true },
      where: eq(secret.storeId, storeId),
      orderBy: asc(secret.createdAt),
    })
    return rows.map((r) => r.key)
  },
  async listAll() {
    const rows = await db.query.secret.findMany({ orderBy: desc(secret.updatedAt) })
    return rows.map(toRecord)
  },
  async listAllKeys() {
    return db.query.secret.findMany({
      columns: { id: true, storeId: true, key: true, updatedAt: true },
      orderBy: desc(secret.updatedAt),
    })
  },
  async set(storeId, key, value, recipe = TYPED) {
    const encrypted = encrypt(value)
    const made = JSON.stringify(recipe)
    await db
      .insert(secret)
      .values({ storeId, key, value: encrypted, recipe: made })
      .onConflictDoUpdate({
        target: [secret.storeId, secret.key],
        set: { value: encrypted, recipe: made, updatedAt: new Date() },
      })
    await storeChanged(storeId)
  },
  async rename(storeId, from, to) {
    if (
      await db.query.secret.findFirst({
        columns: { id: true },
        where: and(eq(secret.storeId, storeId), eq(secret.key, to)),
      })
    ) {
      throw new Error(`Secret "${to}" is already in this store`)
    }
    // One row changes its key in place, so its id, value, recipe and createdAt stay. A row named `to`
    // written since the check above fails the update on the (storeId, key) unique index rather than
    // being overwritten.
    const renamed = await db
      .update(secret)
      .set({ key: to, updatedAt: new Date() })
      .where(and(eq(secret.storeId, storeId), eq(secret.key, from)))
      .returning({ id: secret.id })
    if (renamed.length === 0) {
      throw new Error(`Secret "${from}" is not in this store`)
    }
    await storeChanged(storeId)
  },
  async delete(storeId, key) {
    await db.delete(secret).where(and(eq(secret.storeId, storeId), eq(secret.key, key)))
    await storeChanged(storeId)
  },
  async deleteById(id) {
    const removed = await db.delete(secret).where(eq(secret.id, id)).returning({ storeId: secret.storeId })
    for (const { storeId } of removed) {
      await storeChanged(storeId)
    }
  },
  async deleteStore(storeId) {
    await db.delete(secret).where(eq(secret.storeId, storeId))
    await storeChanged(storeId)
  },
  onStoreChanged(listener) {
    if (!storeChangedListeners.includes(listener)) {
      storeChangedListeners.push(listener)
    }
  },
  async listStores() {
    const rows = await db.query.secret.findMany({ columns: { storeId: true, key: true }, orderBy: asc(secret.storeId) })
    const map = new Map<string, string[]>()
    for (const row of rows) {
      const keys = map.get(row.storeId) ?? []
      keys.push(row.key)
      map.set(row.storeId, keys)
    }
    return Array.from(map.entries()).map(([storeId, keys]) => ({ storeId, keys }))
  },
  async countUndecryptable() {
    const rows = await db.query.secret.findMany({ columns: { value: true } })
    return rows.filter((row) => !canDecrypt(row.value)).length
  },
  async listDecryptableValues() {
    const rows = await db.query.secret.findMany({ columns: { value: true } })
    return rows.filter((row) => canDecrypt(row.value)).map((row) => decrypt(row.value))
  },
}
