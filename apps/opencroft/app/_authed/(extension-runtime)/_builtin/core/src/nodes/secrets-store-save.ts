// What the Secrets Store inspector's Save does with its rows, kept free of the
// host so it can be tested on its own.

import type { SecretRecipe } from '@opencroft/server/secrets'

import type { DeleteOutcome, NodeReference, RenameOutcome } from './delete-refusal-shared'

export interface SecretRow {
  /** The editor's own key for the row, never saved. Each row's editor keeps its reveal state, so it must follow the row. */
  rowId: string
  id?: string
  /** The name the store holds the row under; absent until the row is saved. */
  savedKey?: string
  key: string
  value: string
  /** The value the store holds under `savedKey`; absent until saved. Save writes `value` only when it differs. */
  savedValue?: string
  /** How the stored value was made; null when it was stored without a recipe, absent until saved. */
  recipe?: SecretRecipe | null
  /** Whether Rotate can make the next value, as the store answers. */
  rotatable?: boolean
  updatedAt?: string
  dirty: boolean
}

/** The inspector's unsaved edit: the rows shown, and the saved names whose rows were removed. */
export interface SecretEdit {
  rows: SecretRow[]
  removed: string[]
}

/**
 * The name a value set from the row's menu is written under: the stored name,
 * or a new row's typed one. Undefined while there is none: a new row with no
 * name, or a saved row renamed and not saved yet, since writing under either
 * name would not be what the field shows.
 */
export function rowTarget(row: SecretRow): string | undefined {
  if (row.savedKey !== undefined) {
    return row.key === row.savedKey ? row.savedKey : undefined
  }
  return row.key.trim() || undefined
}

/**
 * Shows a value the store has just written under `key`, leaving every other
 * row as it is, unsaved edits included. The row the menu acted on (the one
 * whose `rowTarget` is `key`) becomes `fresh`; when no row names it, `fresh`
 * is added. Pure, as `removeSecretRow`.
 */
export function mergeWritten(edit: SecretEdit, key: string, fresh: SecretRow): SecretEdit {
  const index = edit.rows.findIndex((row) => rowTarget(row) === key)
  if (index === -1) {
    return { ...edit, rows: [...edit.rows, fresh] }
  }
  return { ...edit, rows: edit.rows.map((row, i) => (i === index ? { ...fresh, rowId: row.rowId } : row)) }
}

/**
 * Removes a row from the edit. A saved row's name joins `removed`: the name
 * the store holds, not the one in the field, since an edited name was never
 * saved and there is nothing under it to delete.
 *
 * Pure, because it runs as a state updater: React's development build calls
 * updaters twice under StrictMode, and the app renders under StrictMode.
 */
export function removeSecretRow(edit: SecretEdit, index: number): SecretEdit {
  const savedKey = edit.rows[index]?.savedKey
  return {
    rows: edit.rows.filter((_, i) => i !== index),
    removed: savedKey ? [...edit.removed, savedKey] : edit.removed,
  }
}

/** A delete or a rename the store refused, with every node and App that names the secret now. */
export interface RefusedChange {
  /** The name the store holds. */
  key: string
  references: NodeReference[]
  /** Set for a rename: the new name, and the row's edited value, written once the rename goes through. */
  rename?: { to: string; value?: string }
}

export interface SaveCalls {
  deleteSecret(key: string): Promise<DeleteOutcome>
  renameSecret(from: string, to: string): Promise<RenameOutcome>
  setSecret(key: string, value: string): Promise<void>
}

export type SaveResult =
  /** Nothing was sent: these rows would be saved without a name. */
  | { status: 'unnamed'; rowIds: string[] }
  /** Nothing was sent: these rows would end up under one name with another row. */
  | { status: 'duplicate'; rowIds: string[] }
  | { status: 'done'; refused: RefusedChange[]; failed: string[] }

/** Rows that would be saved without a name: added or edited, with a blank key. */
export function unnamedRows(rows: SecretRow[]): string[] {
  return rows.filter((row) => row.dirty && !row.key.trim()).map((row) => row.rowId)
}

/**
 * Rows whose trimmed name another row also has, unchanged rows included: the
 * store holds one secret per name, so whichever was written last would take
 * the other's place. Blank names are left to `unnamedRows`.
 */
export function duplicateRows(rows: SecretRow[]): string[] {
  const count = new Map<string, number>()
  for (const row of rows) {
    const name = row.key.trim()
    count.set(name, (count.get(name) ?? 0) + 1)
  }
  return rows.filter((row) => row.key.trim() && (count.get(row.key.trim()) ?? 0) > 1).map((row) => row.rowId)
}

/** The value Save writes for a row: a new row's, or a saved row's when it differs from the stored one. */
function valueToWrite(row: SecretRow): string | undefined {
  return row.savedKey === undefined || row.value !== row.savedValue ? row.value : undefined
}

function failure(key: string, err: unknown): string {
  return `${key}: ${err instanceof Error ? err.message : String(err)}`
}

/**
 * Saves the inspector's edits: deletes the removed names, renames the saved
 * rows whose name changed, then writes every changed value. A blank name, or
 * two rows under one name, stops the whole save before anything is sent, since
 * the person is still editing and either would write a secret over another.
 * Past that, each change stands on its own, so one refused or failed change
 * does not hold back the others; the result says which did not go through.
 *
 * A rename moves the stored secret, value and recipe together, and a value
 * left as it was is not written again, so renaming alone keeps the recipe.
 * Renames go before value writes, so a new row may take a name another row
 * gives up. A row whose rename does not go through writes nothing: under the
 * old name its value would land on the secret it was being moved from.
 */
export async function saveSecrets(rows: SecretRow[], removed: string[], calls: SaveCalls): Promise<SaveResult> {
  const unnamed = unnamedRows(rows)
  if (unnamed.length > 0) {
    return { status: 'unnamed', rowIds: unnamed }
  }
  const duplicates = duplicateRows(rows)
  if (duplicates.length > 0) {
    return { status: 'duplicate', rowIds: duplicates }
  }
  const refused: RefusedChange[] = []
  const failed: string[] = []
  for (const key of removed) {
    try {
      const outcome = await calls.deleteSecret(key)
      if ('refused' in outcome) {
        refused.push({ key, references: outcome.refused.references })
      }
    } catch (err) {
      failed.push(failure(key, err))
    }
  }
  const changed = rows.filter((row) => row.dirty)
  const held = new Set<string>()
  for (const row of changed) {
    if (row.savedKey === undefined || row.key === row.savedKey) {
      continue
    }
    const to = row.key.trim()
    try {
      const outcome = await calls.renameSecret(row.savedKey, to)
      if ('refused' in outcome) {
        refused.push({
          key: row.savedKey,
          references: outcome.refused.references,
          rename: { to, value: valueToWrite(row) },
        })
        held.add(row.rowId)
      }
    } catch (err) {
      failed.push(failure(row.savedKey, err))
      held.add(row.rowId)
    }
  }
  for (const row of changed) {
    const value = valueToWrite(row)
    if (held.has(row.rowId) || value === undefined) {
      continue
    }
    const key = row.key.trim()
    try {
      await calls.setSecret(key, value)
    } catch (err) {
      failed.push(failure(key, err))
    }
  }
  return { status: 'done', refused, failed }
}

/** The calls a confirm's "anyway" makes, each past exactly the nodes in `shown`. */
export interface ListedCalls {
  deleteListed(key: string, shown: string[]): Promise<DeleteOutcome>
  renameListed(from: string, to: string, shown: string[]): Promise<RenameOutcome>
  setSecret(key: string, value: string): Promise<void>
}

export interface AnywayResult {
  deleted: string[]
  renamed: { from: string; to: string }[]
  /** Refused again, with every node that names each now: one the confirm did not list has started naming it. */
  refused: RefusedChange[]
  failed: string[]
}

/**
 * What the confirm's "anyway" does: deletes or renames each secret it listed
 * past the nodes it listed for that secret, and no others. A node that started
 * naming the secret while the confirm was open refuses that change, so the
 * person sees it before anything it uses goes. A renamed row's edited value is
 * written under the new name once the rename is through. Each change stands on
 * its own, as in a save.
 */
export async function applyAnyway(items: RefusedChange[], calls: ListedCalls): Promise<AnywayResult> {
  const result: AnywayResult = { deleted: [], renamed: [], refused: [], failed: [] }
  for (const item of items) {
    const { key, references, rename } = item
    const shown = references.map((ref) => ref.nodeId)
    try {
      const outcome = rename ? await calls.renameListed(key, rename.to, shown) : await calls.deleteListed(key, shown)
      if ('refused' in outcome) {
        result.refused.push({ ...item, references: outcome.refused.references })
        continue
      }
      if (!rename) {
        result.deleted.push(key)
        continue
      }
      result.renamed.push({ from: key, to: rename.to })
    } catch (err) {
      result.failed.push(failure(key, err))
      continue
    }
    if (rename.value !== undefined) {
      try {
        await calls.setSecret(rename.to, rename.value)
      } catch (err) {
        result.failed.push(failure(rename.to, err))
      }
    }
  }
  return result
}
