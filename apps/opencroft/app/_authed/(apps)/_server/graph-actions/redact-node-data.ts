/**
 * What a graph action answers with in place of a credential typed into a node.
 *
 * Node data is read by agents through `getNodes` and `findNodes`, and the nodes
 * `createNodes` and `updateNodes` answer with; every one of those answers lands
 * in a transcript. A field that takes a secret holds `secret:NAME`, which is
 * returned as it is: it names the secret and holds nothing to hide. A value
 * typed into the node instead is hidden here when it looks like a credential.
 * The inspector reads the graph directly and still shows the full value, so
 * the person who owns it can move it into a Secrets Store.
 *
 * WHAT COUNTS, as an enumeration rather than a description:
 *
 *   1. a string under a property named like a credential (`password`,
 *      `chatApiKey`, `sessionToken`, `secret`, an environment map's
 *      `API_TOKEN`), except a `<field>Secret` property, which by convention
 *      holds the name of the secret that stands for `<field>`
 *      (`passwordSecret`, `botTokenSecret`) and is returned as it is;
 *   2. a string under a property the node's type declares as a credential
 *      (`nodeCredentialProperties` in `@opencroft/server/secrets`), for a
 *      credential whose name does not say so;
 *   3. the value of a `{ name, value }` pair (request headers, an MCP
 *      connection's env) whose name reads as a credential, or whose value
 *      starts with an auth scheme (`Bearer …`): the rule the inspector flags
 *      a typed row by;
 *   4. what the text rules of `@/server/redact-text` remove from any string:
 *      the userinfo password of a URL, and any value a Secrets Store holds,
 *      also as a prefix or inside an encoding, when it is long enough not to
 *      be an ordinary word or identifier.
 *
 * A typed credential under an ordinary name, in no URL and in no store, is
 * not seen. That is the gap the inspector's warning is for.
 */

import { credentialPropertiesOf } from '@/app/_authed/(extension-runtime)/_server/node-credential-properties'
import { isCredentialName, isTypedCredential, secretNameOf } from '@/app/_authed/(secrets-store)/_lib/secret-values'
import { knownValues, REDACTED, redactText } from '@/server/redact-text'
import { secrets } from '@/server/secrets'

/** Stands in for a hidden value. A write carrying it is refused (see `findRedacted`). */
export { REDACTED }

// Stored values shorter than this are not searched for in node data. Stores
// also hold identifiers (a registry username, a chat id), and a short one is
// ordinary text: a username that is also an organisation's name would be cut
// out of every URL that names the organisation, on every node of the instance.
// A name or a word rarely runs to twelve characters; a generated key or token
// does. Rules 1 to 3 and URL passwords do not depend on length.
const MIN_VALUE_LENGTH = 12

// A property whose name ends in one of these holds a credential. Matched on the
// end of the name so that `maxTokens`, `secretKeys` and `authStoreId` are not.
// `SECRET_REFERENCE` is checked first.
const CREDENTIAL_PROPERTY = /(password|passwd|passphrase|api[-_]?key|secret|token|credentials?|private[-_]?key)$/i

// An environment map's variable names are upper case; those are judged by the
// wider rule a name/value pair is, so `AWS_SECRET_ACCESS_KEY` counts.
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

// A camelCase `<field>Secret` property holds the NAME of a secret, never a
// value: `apiKeySecret`, a registry's `usernameSecret` / `passwordSecret`. The
// inspectors draw these as secret pickers, so a value cannot be typed there.
// A bare `secret` and snake or upper case forms (`client_secret`) still count
// as credentials.
const SECRET_REFERENCE = /^[a-z][A-Za-z0-9]*Secret$/

const NO_DECLARED: ReadonlySet<string> = new Set()

interface Rules {
  /** The stored values, as `redactText` takes them. */
  known: string[]
  /** The properties the node's type declares as credentials. */
  declared: ReadonlySet<string>
}

function isCredentialProperty(key: string, declared: ReadonlySet<string>): boolean {
  if (declared.has(key)) {
    return true
  }
  if (SECRET_REFERENCE.test(key)) {
    return false
  }
  return CREDENTIAL_PROPERTY.test(key) || (ENV_NAME.test(key) && isCredentialName(key))
}

function isTyped(value: string): boolean {
  return value.trim() !== '' && secretNameOf(value) === undefined
}

function isNamedValue(value: Record<string, unknown>): value is { name: string; value: string } {
  return typeof value.name === 'string' && typeof value.value === 'string'
}

function redact(value: unknown, key: string | undefined, rules: Rules): unknown {
  if (typeof value === 'string') {
    if (key !== undefined && isCredentialProperty(key, rules.declared) && isTyped(value)) {
      return REDACTED
    }
    return redactText(value, rules.known)
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, undefined, rules))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    out[k] = redact(v, k, rules)
  }
  if (isNamedValue(record) && isTypedCredential(record.name, record.value)) {
    out.value = REDACTED
  }
  return out
}

/**
 * A node's data with typed credentials hidden, given the values the Secrets
 * Stores hold and the properties the node's type declares as credentials.
 * Never changes `data`; returns a copy.
 */
export function redactNodeData(
  data: unknown,
  storedValues: string[],
  declared: ReadonlySet<string> = NO_DECLARED,
): unknown {
  return redact(data, undefined, { known: knownValues(storedValues, MIN_VALUE_LENGTH), declared })
}

/**
 * A redactor over `nodes`, reading the stored values and the declared
 * credential properties of their types once for all of them.
 *
 * Throws when the store cannot be read: a read that cannot establish what to
 * hide does not go on to show it.
 */
export async function nodeRedactor(
  nodes: Iterable<{ type?: unknown }>,
): Promise<<T extends { type?: unknown; data?: unknown }>(node: T) => T> {
  const [stored, declaredByType] = await Promise.all([
    secrets.listDecryptableValues(),
    credentialPropertiesOf(Array.from(nodes, (node) => node.type)),
  ])
  const known = knownValues(stored, MIN_VALUE_LENGTH)
  return (node) => {
    if (node.data === undefined) {
      return node
    }
    const declared = (typeof node.type === 'string' && declaredByType.get(node.type)) || NO_DECLARED
    return { ...node, data: redact(node.data, undefined, { known, declared }) }
  }
}

/**
 * The path of the first string in `value` that holds the placeholder a read
 * put in place of a credential, or undefined. Written back, it would replace
 * the credential with the placeholder.
 */
export function findRedacted(value: unknown, path = ''): string | undefined {
  if (typeof value === 'string') {
    return value.includes(REDACTED) ? path || '(value)' : undefined
  }
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const found = findRedacted(v, path ? `${path}.${k}` : k)
    if (found) {
      return found
    }
  }
  return undefined
}
