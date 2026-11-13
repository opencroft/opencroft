import { type SecretFormat, secrets } from '@opencroft/server/secrets'
import { crypto } from '@opencroft/server/system'

import type { DeleteOutcome, RenameOutcome } from '../src/nodes/delete-refusal-shared'
import type { DeleteOverride } from './checked-delete'
import { type MadeSecret, makeLoginPassword, makeRandom, makeTyped, randomChoice } from './secret-recipes'
import { deleteSecretChecked, renameSecretChecked, type SecretReference } from './secret-references'
import { requireSecretName, rotateSecretChecked, setSecretChecked } from './secret-writes'

// ═══════════════════════════════════════════════════════════════════
// Secrets Store — generate, set, rotate, checked rename and checked delete
//
// Server-side only: a generated value is written straight into the store
// and never appears in this module's return value, so it can't leak into a
// UI toast, an MCP tool result, or an agent's context. Each write stores how
// the value was made (its recipe), which Rotate repeats.
// ═══════════════════════════════════════════════════════════════════

export interface GenerateSecretOptions {
  length?: number
  format?: SecretFormat
  /** The value goes under the `Bearer ` prefix. */
  bearer?: boolean
}

export interface GenerateSecretResult {
  name: string
  status: 'created' | 'rotated'
}

function write(storeId: string, key: string, made: MadeSecret): Promise<void> {
  return secrets.set(storeId, key, made.value, made.recipe)
}

export async function secretsStoreGenerate(
  storeId: string,
  name: string,
  options?: GenerateSecretOptions,
): Promise<GenerateSecretResult> {
  const key = requireSecretName(name)
  const choice = randomChoice(options)
  const existing = await secrets.get(storeId, key)
  const status: GenerateSecretResult['status'] = existing === null ? 'created' : 'rotated'
  await write(storeId, key, makeRandom(choice, crypto.randomString))
  return { name: key, status }
}

/** Stores a value a person typed, as it is. */
export function secretsStoreSet(storeId: string, name: string, value: string): Promise<void> {
  return setSecretChecked(name, makeTyped(value), (key, m) => write(storeId, key, m))
}

/** Stores a login and password as `login:password`, or with `basic` as an HTTP Basic
 *  `Authorization` header value (see `makeLoginPassword`). */
export function secretsStoreSetPassword(
  storeId: string,
  name: string,
  login: unknown,
  password: unknown,
  basic: boolean,
): Promise<void> {
  return setSecretChecked(name, makeLoginPassword(login, password, basic), (key, m) => write(storeId, key, m))
}

/** Replaces an existing secret's value with a new random one, made here, so the
 *  new value stays on the server: by `options` when given, which become its
 *  recipe, or else by its stored recipe. */
export function secretsStoreRotate(
  storeId: string,
  name: string,
  options?: GenerateSecretOptions,
): Promise<GenerateSecretResult> {
  return rotateSecretChecked(
    name,
    {
      listRecipes: async () => new Map((await secrets.list(storeId)).map((row) => [row.key, row.recipe])),
      write: (key, made) => write(storeId, key, made),
    },
    crypto.randomString,
    options === undefined ? undefined : randomChoice(options),
  )
}

/** The nodes on the store's graph and the Apps of its space that name a secret it holds. */
export function secretsStoreReferences(storeId: string, name: string): Promise<SecretReference[]> {
  return secrets.references(storeId, name)
}

/** Deletes a secret by name unless a node or App the override does not cover still names it (see `deleteChecked`). */
export function secretsStoreDelete(storeId: string, name: string, override: DeleteOverride): Promise<DeleteOutcome> {
  return deleteSecretChecked(name, override, {
    listKeys: () => secrets.listKeys(storeId),
    listReferences: () => secrets.references(storeId, name),
    remove: () => secrets.delete(storeId, name),
  })
}

/** Renames a secret, keeping its value and recipe, unless the store already holds the new name or
 *  a node or App the override does not cover still names the old one (see `renameSecretChecked`). */
export function secretsStoreRename(
  storeId: string,
  from: string,
  to: string,
  override: DeleteOverride,
): Promise<RenameOutcome> {
  return renameSecretChecked(from, to, override, {
    listKeys: () => secrets.listKeys(storeId),
    listReferences: () => secrets.references(storeId, from),
    rename: (key) => secrets.rename(storeId, from, key),
  })
}
