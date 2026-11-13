import type { GraphNodeRecord } from '@opencroft/server/graph'
import type { SecretReference } from '@opencroft/server/secrets'

import { secretNameOf } from './secret-values'

// ═══════════════════════════════════════════════════════════════════
// Secret references
//
// Which nodes and Apps name a secret, so that deleting one can refuse or warn
// rather than break whatever reads it. Which nodes and Apps to look at is the
// resolver's question (`referencesToStores` in `server/secrets.ts`); this
// module only reads what each of them names.
//
// Three conventions name a secret in node data. Each is matched the way the
// code that resolves it reads it, so a reference is seen exactly when
// something can act on one:
//
//   1. `secrets`      — one name per line, injected as environment variables
//                       by a script node in the line form (`readEnvironment`
//                       in the core script nodes' `script-environment.ts`). A
//                       field that is not a string is not a reference missed
//                       here: readEnvironment cannot inject from one either,
//                       so nothing is holding that name.
//   2. `apiKeySecret` — exactly one name, matched VERBATIM rather than
//                       trimmed, because the agent path resolves it verbatim.
//                       A padded value resolves to nothing there, so it
//                       references nothing here.
//   3. `secret:NAME`  — standing in for a literal value, anywhere in the
//                       node's data, read by `secretNameOf` as `resolveValue`
//                       reads it. This one is value-shaped rather than
//                       field-shaped, so it is found without knowing which
//                       field holds it — which is what lets it reach node
//                       types owned by extensions this code knows nothing
//                       about. An App's parameters are read by this one only:
//                       their ids are the App's own, so a parameter called
//                       `secrets` means nothing here.
//
// What it cannot see is a FOURTH convention: a node type naming a secret in a
// field of its own that holds a bare name. Nothing here can discover that, so
// an empty result means "nothing matched the three conventions above" and
// never "nothing references this". The two have to stay distinct wherever the
// result is reported, or a pass starts reading as a guarantee it is not.
//
// Nothing here resolves a value or asks whether the name exists. What matters
// is what the graph SAYS it needs, because that is what breaks when the name
// stops resolving.
//
// Host-free, so the browser and the server load the same rules.
// ═══════════════════════════════════════════════════════════════════

/** Node-data field naming the secrets a node needs, one per line. */
const SECRETS_FIELD = 'secrets'

/** Node-data field holding exactly one secret name. */
const API_KEY_SECRET_FIELD = 'apiKeySecret'

/** An App instance as the scan reads it. */
export interface AppSecretHolder {
  /** The App's address, `<space>.<slug>`: what every tool reaches it by. */
  address: string
  /** The App's qualified type. */
  type: string
  name: string
  params: Record<string, string>
}

/** The nodes and Apps that name one secret. */
export interface SecretKeyReferences {
  key: string
  references: SecretReference[]
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

/** Every name a `secret:NAME` value anywhere inside `value` stands for. */
function valueReferencedNames(value: unknown, names: Set<string>): Set<string> {
  for (const text of stringValues(value)) {
    const name = secretNameOf(text)
    if (name) {
      names.add(name)
    }
  }
  return names
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

  return valueReferencedNames(data, names)
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

/** Every App whose parameters name `key` as `secret:NAME`, in the order the Apps were given. */
export function findAppSecretReferences(apps: AppSecretHolder[], key: string): SecretReference[] {
  const wanted = key.trim()
  return apps
    .filter((app) => valueReferencedNames(app.params, new Set()).has(wanted))
    .map((app) => ({ nodeId: app.address, nodeType: `app:${app.type}`, nodeName: app.name }))
}

/** A node or App the way a message names it: what a person recognises it by, and the id to find it. */
export function describeSecretReference(ref: SecretReference): string {
  return `${ref.nodeName ?? ref.nodeType ?? 'node'} (${ref.nodeId})`
}
