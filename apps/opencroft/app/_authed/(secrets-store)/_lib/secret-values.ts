// ═══════════════════════════════════════════════════════════════════
// Values that stand for a secret
//
// STORED FORM. A node field that may hold a credential holds either typed
// text or `secret:<NAME>`, the name of a secret in a Secrets Store. The value
// is resolved server-side where it is used (`secrets.resolveValue`), and the
// node's data only ever holds the name. The prefix is the host's convention,
// so the check before a secret is deleted finds these references in any
// node's data without knowing the field.
//
// A credential typed as a value sits in the node's data, and every read of
// the node (a graph read by an agent, an export, a copy) carries it. Nothing
// here moves such a value: the field flags it, node reads leave it out, and
// the person who owns it puts it in a Secrets Store and picks it by name. A
// value that has sat in node data may already have been read, so a fresh
// credential is the remedy, not a move of the old one.
//
// Host-free, so the browser and the server load the same rules.
// ═══════════════════════════════════════════════════════════════════

export const SECRET_PREFIX = 'secret:'

/** Where a value comes from: typed, or a stored secret named here. */
export type SecretValue = { value: string } | { secret: string }

/** One name/value pair of a list that may take secrets: request headers, environment variables. */
export interface NamedValue {
  name: string
  value: string
}

export function isSecret(value: SecretValue): value is { secret: string } {
  return 'secret' in value
}

/** The secret a stored value names, trimmed the way it is resolved, or undefined for typed text. */
export function secretNameOf(stored: string): string | undefined {
  return stored.startsWith(SECRET_PREFIX) ? stored.slice(SECRET_PREFIX.length).trim() : undefined
}

/** A stored value as a field shows it: the secret it names, or typed text. */
export function readSecretValue(stored: string | undefined): SecretValue {
  const raw = typeof stored === 'string' ? stored : ''
  const secret = secretNameOf(raw)
  return secret === undefined ? { value: raw } : { secret }
}

/** A field's value in the stored form: a secret by name only, never its value. */
export function storeSecretValue(value: SecretValue): string {
  return isSecret(value) ? `${SECRET_PREFIX}${value.secret}` : value.value
}

/** Stored pairs as the table's rows. A row with a blank name is never used, and the table cannot hold one. */
export function readNamedValues(entries: NamedValue[] | undefined): ({ name: string } & SecretValue)[] {
  const rows: ({ name: string } & SecretValue)[] = []
  for (const entry of entries ?? []) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    if (!name) {
      continue
    }
    rows.push({ name, ...readSecretValue(typeof entry.value === 'string' ? entry.value : '') })
  }
  return rows
}

/** The table's rows in the stored form. */
export function storeNamedValues(rows: ({ name: string } & SecretValue)[]): NamedValue[] {
  return rows.map((row) => ({ name: row.name, value: storeSecretValue(row) }))
}

// Header and variable names that carry a credential by convention or by their
// wording. A heuristic, so it errs towards flagging: a false warning costs a
// glance, a missed one leaves a credential in every read of the node.
const CREDENTIAL_NAME = /auth|api[-_]?key|token|secret|passw|credential|cookie|session/i

// Schemes that announce a credential whatever the header is called.
const CREDENTIAL_VALUE = /^\s*(bearer|basic|token)\s+\S/i

/** Whether a name in a name/value list reads as one that carries a credential. */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAME.test(name)
}

/** Whether a typed name/value pair looks like a credential. A secret reference never does. */
export function isTypedCredential(name: string, value: string): boolean {
  if (!value.trim() || secretNameOf(value) !== undefined) {
    return false
  }
  return isCredentialName(name) || CREDENTIAL_VALUE.test(value)
}

/** What stores the typed value, as the warning names it: a node's data or an App's own settings. */
export type CredentialHolder = 'node' | 'app'

const HOLDER_WORDS: Record<CredentialHolder, string> = { node: 'the node', app: "the App's settings" }

/**
 * The sentence shown for a credential typed where a secret belongs. `subject` names the field or
 * the row.
 */
export function typedCredentialSentence(subject: string, holder: CredentialHolder = 'node'): string {
  const where = HOLDER_WORDS[holder]
  return `${subject} holds a credential typed into ${where}, so anyone who reads ${where} reads it. Put it in a Secrets Store and pick it with the key button.`
}

/** A list's warning for a typed value that looks like a credential. */
export function typedCredentialWarning(
  { name, value }: NamedValue,
  holder: CredentialHolder = 'node',
): string | undefined {
  return isTypedCredential(name, value) ? typedCredentialSentence(name, holder) : undefined
}
