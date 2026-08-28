import type { GraphNodeRecord } from '@opencroft/server'

// ═══════════════════════════════════════════════════════════════════
// Secret references
//
// Which nodes on the graph name a secret, so that deleting one can refuse
// rather than break whatever reads it.
//
// A node names the secrets it needs in its `secrets` field, one name per line.
// That field and that parse are the host's: `resolveEnv` in
// `_server/exec-dispatch.ts` injects from exactly this shape, and a node whose
// `secrets` field is not a string is not resolvable there either — so a
// non-string field is not a reference this misses, it is one nothing can
// satisfy. The two have to move together: a second field that names a secret
// becomes resolvable and referenced in the same change.
//
// Nothing here resolves a value or asks whether the name exists. What matters
// is what the graph SAYS it needs, because that is what breaks when the name
// stops resolving.
// ═══════════════════════════════════════════════════════════════════

/** The node-data field naming the secrets a node needs, one per line. */
const SECRET_REFERENCE_FIELD = 'secrets'

/**
 * The parameter a caller passes to delete a secret that is still referenced.
 *
 * Deliberately the name `compile_extension` already uses for its own override
 * rather than a second word for the same idea: a caller who has met one of
 * these refusals can get past this one without looking anything up.
 */
export const DELETE_OVERRIDE_PARAM = 'allowUnclean'

export interface SecretReference {
  nodeId: string
  nodeType?: string
  /** The node's own `name`, when it has one — what a person recognises it by. */
  nodeName?: string
}

export interface SecretDeleteRefusal {
  references: SecretReference[]
  message: string
}

function referencedNames(data: Record<string, unknown>): string[] {
  const field = data[SECRET_REFERENCE_FIELD]
  if (typeof field !== 'string') {
    return []
  }
  return field
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Every node whose `secrets` field names `key`, in the order the nodes were given. */
export function findSecretReferences(nodes: GraphNodeRecord[], key: string): SecretReference[] {
  // No guard for an empty key: `referencedNames` drops blank lines, so nothing
  // it returns can equal '' and an empty key matches nothing on its own. The
  // test that pins this is pinning that pair, not a branch.
  const wanted = key.trim()
  const found: SecretReference[] = []
  for (const node of nodes) {
    const data = node.data ?? {}
    if (!referencedNames(data).includes(wanted)) {
      continue
    }
    const name = data.name
    found.push({
      nodeId: node.id,
      nodeType: node.type,
      nodeName: typeof name === 'string' && name.trim() ? name.trim() : undefined,
    })
  }
  return found
}

function describeReference(ref: SecretReference): string {
  return `${ref.nodeName ?? ref.nodeType ?? 'node'} (${ref.nodeId})`
}

/**
 * Whether a secret may be deleted, and if not, why — naming the nodes that
 * still reference it.
 *
 * The break a live reference causes is a delayed one, which is the reason to
 * refuse rather than warn: a running container is holding the value it resolved
 * when it started, so nothing goes wrong until the next deploy, by which time
 * the deletion is not what anyone is looking at.
 *
 * A dangling reference is a legitimate thing to want, so the refusal is
 * advisory in the same sense as the compile guard: `override` always gets
 * through, and it is never the default.
 */
export function refuseSecretDelete(
  key: string,
  references: SecretReference[],
  override: boolean,
): SecretDeleteRefusal | null {
  if (override || references.length === 0) {
    return null
  }
  const subject = references.length === 1 ? '1 node' : `${references.length} nodes`
  return {
    references,
    message:
      `Refusing to delete "${key}": it is still named by ${subject} — ${references.map(describeReference).join(', ')}. ` +
      `Those nodes resolve it by name the next time they deploy or run, and a container that is already running keeps ` +
      `the value it resolved at startup, so the break would not surface until then. ` +
      `Remove the reference, or pass ${DELETE_OVERRIDE_PARAM}: true to delete it anyway.`,
  }
}
