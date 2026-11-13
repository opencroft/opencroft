import type { DeleteOutcome, DeleteRefusal, NodeReference } from '../src/nodes/delete-refusal-shared'

// ═══════════════════════════════════════════════════════════════════
// Checked delete
//
// The delete both stores run (the Secrets Store's secrets and the Key
// Store's keys): refused while a node still names the item, unless the
// caller overrides. Each store gives its own files and its own wording.
// ═══════════════════════════════════════════════════════════════════

/** The parameter an agent's `delete` action takes to delete an item a node still names. */
export const DELETE_OVERRIDE_PARAM = 'allowUnclean'

/**
 * How far a caller overrides the refusal. `true` deletes whatever still names
 * the item. A list of node ids deletes past exactly those nodes: the ones a
 * confirm showed the person, so a node that starts naming the item while the
 * confirm is open is refused and shown, never deleted past unseen.
 */
export type DeleteOverride = boolean | readonly string[]

/**
 * The override an inspector's confirm sends: the ids of the nodes it listed.
 * Anything that is not a list overrides nothing, so no client value deletes
 * past every node.
 */
export function shownOverride(shown: unknown): DeleteOverride {
  return Array.isArray(shown) ? shown.filter((id): id is string => typeof id === 'string') : false
}

/** What a store gives for one checked delete. */
export interface CheckedDeleteStore {
  /** The names the store holds. */
  listKeys(): Promise<string[]>
  /** The nodes and Apps that name the item. */
  listReferences(): Promise<NodeReference[]>
  /** Removes the item; called only once every check has passed. */
  remove(): Promise<void>
}

/** The store's wording for the two ways a delete does not happen. */
export interface DeleteMessages {
  absent(name: string): string
  refused(name: string, references: NodeReference[]): string
}

/** The nodes the way a message names them: what a person recognises each by, and the id to find it. */
export function nameReferences(references: NodeReference[]): string {
  return references.map((ref) => `${ref.nodeName ?? ref.nodeType ?? 'node'} (${ref.nodeId})`).join(', ')
}

/**
 * The refusal for an item a node the override does not cover still names, with
 * every node that names it; undefined when the override covers them all.
 * Shared by every change that leaves those nodes naming nothing: a delete, and
 * a secret's rename.
 */
export async function refusalPast(
  override: DeleteOverride,
  listReferences: () => Promise<NodeReference[]>,
  message: (references: NodeReference[]) => string,
): Promise<DeleteRefusal | undefined> {
  if (override === true) {
    return undefined
  }
  const acknowledged = override === false ? [] : override
  const references = await listReferences()
  return references.some((ref) => !acknowledged.includes(ref.nodeId))
    ? { references, message: message(references) }
    : undefined
}

/**
 * Deletes one item, unless a node the override does not cover still names it.
 * An absent name throws rather than reporting a deletion: a typo, or a name
 * that lives in another store, would otherwise read as done having removed
 * nothing. A refusal is returned rather than thrown, so an inspector can show
 * who still names the item and offer the override; an agent action throws its
 * message.
 */
export async function deleteChecked(
  name: string,
  override: DeleteOverride,
  store: CheckedDeleteStore,
  messages: DeleteMessages,
): Promise<DeleteOutcome> {
  if (!(await store.listKeys()).includes(name)) {
    throw new Error(messages.absent(name))
  }
  const refused = await refusalPast(override, store.listReferences, (references) => messages.refused(name, references))
  if (refused) {
    return { refused }
  }
  await store.remove()
  return { deleted: name }
}
