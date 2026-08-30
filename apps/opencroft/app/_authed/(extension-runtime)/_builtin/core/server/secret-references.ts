import type { GraphNodeRecord } from '@opencroft/server'

// ═══════════════════════════════════════════════════════════════════
// Secret references
//
// Which nodes on the graph name a secret, so that deleting one can refuse
// rather than break whatever reads it.
//
// Three conventions name a secret in node data. Each is matched the way the
// code that resolves it reads it, so a reference is seen exactly when
// something can act on one:
//
//   1. `secrets`      — one name per line, injected as environment variables
//                       by `resolveEnv` in `_server/exec-dispatch.ts`. A field
//                       that is not a string is not a reference missed here:
//                       resolveEnv cannot inject from one either, so nothing
//                       is holding that name.
//   2. `apiKeySecret` — exactly one name, matched VERBATIM rather than
//                       trimmed, because the agent path resolves it verbatim.
//                       A padded value resolves to nothing there, so it
//                       references nothing here.
//   3. `secret:NAME`  — standing in for a literal value, anywhere in the
//                       node's data. This one is value-shaped rather than
//                       field-shaped, so it is found without knowing which
//                       field holds it — which is what lets it reach node
//                       types owned by extensions this code knows nothing
//                       about.
//
// What it cannot do is see a FOURTH convention: a node type naming a secret in
// a field of its own that holds a bare name. Nothing here can discover that,
// so an empty result means "nothing matched the three conventions above" and
// never "nothing references this". The two have to stay distinct wherever the
// result is reported, or a pass starts reading as a guarantee it is not.
//
// Nothing here resolves a value or asks whether the name exists. What matters
// is what the graph SAYS it needs, because that is what breaks when the name
// stops resolving.
// ═══════════════════════════════════════════════════════════════════

/** Node-data field naming the secrets a node needs, one per line. */
const SECRETS_FIELD = 'secrets'

/** Node-data field holding exactly one secret name. */
const API_KEY_SECRET_FIELD = 'apiKeySecret'

/** Value prefix standing in for a literal value, anywhere in a node's data. */
const SECRET_VALUE_PREFIX = 'secret:'

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

/**
 * Every string anywhere inside a value.
 *
 * Unbounded by design: node data is parsed from the graph's stored JSON, so it
 * cannot contain a cycle, and a depth limit would silently stop finding
 * references below it — a scan that quietly under-reports is the one failure
 * this must not have.
 */
function* stringValues(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield value
    return
  }
  if (value === null || typeof value !== 'object') {
    return
  }
  for (const entry of Object.values(value)) {
    yield* stringValues(entry)
  }
}

/** Every secret name a node's data asks for, by any of the three conventions. */
function referencedNames(data: Record<string, unknown>): Set<string> {
  const names = new Set<string>()

  const lines = data[SECRETS_FIELD]
  if (typeof lines === 'string') {
    for (const line of lines.split('\n')) {
      const name = line.trim()
      if (name) {
        names.add(name)
      }
    }
  }

  const single = data[API_KEY_SECRET_FIELD]
  if (typeof single === 'string' && single) {
    names.add(single)
  }

  // These two lines are load-bearing together, which is the part a test run will not tell you.
  // The slice takes from a FIXED offset, so `startsWith` decides whether anything is extracted
  // and never what — relax it to `includes` on its own and the extraction still misses, so every
  // test stays green. Take the name from `indexOf(prefix)` on its own and, with `startsWith`
  // still guarding, the index is always 0 and the two slices are identical, so every test stays
  // green again. Change BOTH and `Bearer secret:SPEECH_KEY` starts resolving to a reference,
  // which is the fixture that catches it. Measured, 30.08.2026: each mutation alone survives the
  // suite; together they fail exactly one test.
  for (const value of stringValues(data)) {
    if (!value.startsWith(SECRET_VALUE_PREFIX)) {
      continue
    }
    const name = value.slice(SECRET_VALUE_PREFIX.length).trim()
    if (name) {
      names.add(name)
    }
  }

  return names
}

/** Every node whose data names `key`, in the order the nodes were given. */
export function findSecretReferences(nodes: GraphNodeRecord[], key: string): SecretReference[] {
  // No guard for an empty key: every convention drops the empty name, so
  // nothing `referencedNames` returns can equal '' and an empty key matches
  // nothing on its own. The test that pins this is pinning that pair, not a
  // branch.
  const wanted = key.trim()
  const found: SecretReference[] = []
  for (const node of nodes) {
    const data = node.data ?? {}
    if (!referencedNames(data).has(wanted)) {
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
