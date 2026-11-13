import type { SecretReference } from '@opencroft/server/secrets'

import type { DeleteOutcome, NodeReference, RenameOutcome } from '../src/nodes/delete-refusal-shared'
import {
  type CheckedDeleteStore,
  DELETE_OVERRIDE_PARAM,
  type DeleteOverride,
  deleteChecked,
  nameReferences,
  refusalPast,
} from './checked-delete'
import { requireSecretName } from './secret-writes'

// ═══════════════════════════════════════════════════════════════════
// Refusing a secret delete or rename
//
// Which nodes and Apps name a secret is the host's answer
// (`secrets.references`): it reads them from the same scopes the names
// resolve in, so the check follows the resolver. An empty answer means
// nothing matched the conventions the host reads, never that nothing uses
// the secret.
// ═══════════════════════════════════════════════════════════════════

export type { SecretReference }

/**
 * Why a secret a node or App still names is not deleted, naming each of them.
 *
 * The break a live reference causes is a delayed one, which is the reason to
 * refuse rather than warn: a running container is holding the value it resolved
 * when it started, so nothing goes wrong until the next deploy, by which time
 * the deletion is not what anyone is looking at.
 *
 * A dangling reference is a legitimate thing to want, so the refusal is
 * advisory in the same sense as the compile guard: the override always gets
 * through, and it is never the default.
 */
export function secretDeleteRefusal(key: string, references: SecretReference[]): string {
  const subject = references.length === 1 ? '1 node or App' : `${references.length} nodes or Apps`
  return (
    `Refusing to delete "${key}": it is still named by ${subject} — ${nameReferences(references)}. ` +
    `They resolve it by name the next time they deploy, run or start, and a container that is already running keeps ` +
    `the value it resolved at startup, so the break would not surface until then. ` +
    `Remove the reference, or pass ${DELETE_OVERRIDE_PARAM}: true to delete it anyway.`
  )
}

/**
 * Deletes one secret, unless a node or App still names it (see
 * `deleteChecked`). The one way the app deletes a secret by name, for an
 * agent's `delete` action and the inspector alike, so they cannot disagree
 * about what is refused. `secret-delete-paths.test.ts` fails when a second
 * caller of the store's delete appears.
 */
export function deleteSecretChecked(
  name: string,
  override: DeleteOverride,
  store: CheckedDeleteStore,
): Promise<DeleteOutcome> {
  return deleteChecked(name, override, store, {
    absent: (absent) => `Secret "${absent}" is not in this store`,
    refused: secretDeleteRefusal,
  })
}

/** What a store gives for one checked rename. */
export interface CheckedRenameStore {
  /** The names the store holds. */
  listKeys(): Promise<string[]>
  /** The nodes and Apps that name the secret by its current name. */
  listReferences(): Promise<NodeReference[]>
  /** Gives the secret the new name; called only once every check has passed. */
  rename(to: string): Promise<void>
}

/** Why a secret a node or App still names is not renamed, naming each of them. */
export function secretRenameRefusal(from: string, to: string, references: NodeReference[]): string {
  const subject = references.length === 1 ? '1 node or App' : `${references.length} nodes or Apps`
  return (
    `Refusing to rename "${from}" to "${to}": it is still named by ${subject} — ${nameReferences(references)}. ` +
    `They go on naming "${from}", which then resolves to nothing, so they fail the next time they deploy, run or start.`
  )
}

/**
 * Renames one secret, keeping its value and recipe. `from` is the exact stored
 * name; `to` is a new name, trimmed. Refused, as a delete is, while a node or
 * App the override does not cover names `from`: a rename leaves them naming a
 * secret that is gone. A name the store already holds is refused outright,
 * with no override, so no secret is ever overwritten by a rename.
 */
export async function renameSecretChecked(
  from: string,
  to: string,
  override: DeleteOverride,
  store: CheckedRenameStore,
): Promise<RenameOutcome> {
  const key = requireSecretName(to)
  const keys = await store.listKeys()
  if (!keys.includes(from)) {
    throw new Error(`Secret "${from}" is not in this store`)
  }
  if (key === from) {
    return { renamed: key }
  }
  if (keys.includes(key)) {
    throw new Error(`A secret named "${key}" is already in this store; delete it or choose another name`)
  }
  const refused = await refusalPast(override, store.listReferences, (references) =>
    secretRenameRefusal(from, key, references),
  )
  if (refused) {
    return { refused }
  }
  await store.rename(key)
  return { renamed: key }
}
