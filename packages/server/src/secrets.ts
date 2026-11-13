/** `@opencroft/server/secrets` — the encrypted Secrets Store. */

/** The alphabet a random value is drawn from. */
export type SecretFormat = 'hex' | 'base64url' | 'password' | 'alphanumeric' | 'symbols'

/** A random value's length and alphabet. */
export interface RandomSecretSpec {
  length: number
  format: SecretFormat
}

/**
 * How a stored value was made, kept beside it so that Rotate makes the next value the same way.
 * It never holds a part of the value.
 *
 * - `typed`: a value someone brought (an external API key, a password). Nothing here can make the
 *   next one, so it is not rotated.
 * - `random`: drawn on the server.
 * - `basic`: `Basic base64(login:password)`, for an `Authorization` header, from a login and a
 *   password someone brought. Only the login is kept; like `typed`, it is not rotated.
 * - `login`: `login:password` as it is, the form `curl -u` takes, from a login and a password
 *   someone brought. Only the login is kept, and it is not rotated.
 * - `bearer`: `Bearer <token>`, for an `Authorization` header, the token drawn on the server.
 */
export type SecretRecipe =
  | { kind: 'typed' }
  | ({ kind: 'random' } & RandomSecretSpec)
  | { kind: 'basic'; login: string }
  | { kind: 'login'; login: string }
  | { kind: 'bearer'; token: RandomSecretSpec }

/** A stored secret with its decrypted value. */
export interface SecretRecord {
  id: string
  storeId: string
  key: string
  value: string
  /** Null for a secret stored without a recipe; Rotate treats it as random with the defaults. */
  recipe: SecretRecipe | null
  updatedAt: Date
}

/** Where a stored secret lives and what it is called, without its value. */
export type SecretKeyRecord = Omit<SecretRecord, 'value' | 'recipe'>

/**
 * Where a secret's name is looked up, which is what the inspector's pickers offer there.
 *
 * - `nodeId`: the Secrets Stores on the graph that holds this node. A node's own field (a
 *   `secret:<NAME>` value, a `secrets` line, an `apiKeySecret`) resolves with the node's id.
 * - `spaceSlug`: the Secrets Stores on every graph of this space, for an App, which belongs to a
 *   space rather than to a graph.
 *
 * A name is never looked up in another space, and a name missing from the scope is not looked up
 * anywhere else.
 */
export type SecretScope = { nodeId: string } | { spaceSlug: string }

/** A node or an App that names a secret. */
export interface SecretReference {
  /** The node's id, or the App's address (`<space>.<slug>`). */
  nodeId: string
  /** The node's type; `app:<type>` for an App. */
  nodeType?: string
  /** The node's own `name`, or the App's name: what a person recognises it by. */
  nodeName?: string
}

/** Read/write access to the encrypted Secrets Store. Values cross this API as plaintext. */
export interface HostSecretsApi {
  /**
   * Resolve a secret value by key within `scope`; null if no store there holds it. Two stores in
   * the scope holding the key: the older row wins. Throws when the scope is missing or names no
   * node or space on the instance.
   */
  resolve(key: string, scope: SecretScope): Promise<string | null>
  /**
   * Resolve a node field that may stand for a secret, at the moment it is used.
   * `secret:<NAME>` gives the value of the secret NAME within `scope` (as
   * `resolve`); anything else is typed text and comes back as it is. Throws,
   * naming the secret and the graph or space, when no store there holds NAME:
   * an empty value would reach the remote end as a blank credential and fail
   * there as something else.
   */
  resolveValue(value: string, scope: SecretScope): Promise<string>
  /**
   * The nodes and Apps that would resolve `key` from `storeId` and name it: the nodes on the
   * store's graph and the Apps of its space, by the scopes `resolve` takes. Empty for a store on
   * no graph, which no scope reaches. Names only what node data and App parameters say (a
   * `secrets` line, an `apiKeySecret`, a `secret:<NAME>` value), so empty is not proof that
   * nothing uses the secret.
   */
  references(storeId: string, key: string): Promise<SecretReference[]>
  /** Read a secret value within a specific store; null if absent. */
  get(storeId: string, key: string): Promise<string | null>
  /** List the secrets in a store, oldest first. */
  list(storeId: string): Promise<SecretRecord[]>
  /**
   * List the key NAMES in a store, oldest first.
   *
   * Separate from `list` rather than derived from it: this one never decrypts,
   * so a caller that must not handle values — an agent-invokable node action —
   * cannot leak one by returning the wrong field.
   */
  listKeys(storeId: string): Promise<string[]>
  /** List every secret across all stores, most-recently-updated first. */
  listAll(): Promise<SecretRecord[]>
  /**
   * List every secret across all stores without its value, most-recently-updated
   * first. Never decrypts, so it also lists rows the instance's key cannot read.
   */
  listAllKeys(): Promise<SecretKeyRecord[]>
  /**
   * Create or update a secret value, with how it was made. Without a recipe the value is recorded
   * as typed: it came from outside, so nothing can make the next one.
   */
  set(storeId: string, key: string, value: string, recipe?: SecretRecipe): Promise<void>
  /**
   * Give a secret within a store a new name. The secret keeps its value, its recipe and its age
   * (which decides between two stores holding one name), and is never decrypted on the way. Throws
   * when the store does not hold `from`, or already holds `to`: nothing is overwritten. Whatever
   * names `from` stops resolving.
   */
  rename(storeId: string, from: string, to: string): Promise<void>
  /** Delete a secret within a store. */
  delete(storeId: string, key: string): Promise<void>
  /** Delete a secret by its id. */
  deleteById(id: string): Promise<void>
}

export declare const secrets: HostSecretsApi

/** Redaction for text that arrives in pieces, such as a container's output while it runs. */
export interface StreamRedactor {
  /** Take the next piece; return whatever can now be released, redacted. */
  push(text: string): string
  /** Release everything still held, redacted. Call once, when the stream has ended. */
  flush(): string
}

/**
 * Removes credentials from text, with the values it knows read once, when it was made. Each
 * credential is replaced by `[redacted]`. It removes:
 *
 * - the userinfo password of a URL anywhere in the text (`scheme://user:pw@host`);
 * - every value the Secrets Stores hold, and every value the caller passed: literally, as a
 *   prefix of at least twelve characters, and inside base64, base64url, percent-encoded,
 *   JSON-escaped or compose-escaped text. A value shorter than `minValueLength` is not searched
 *   for, so ordinary words such as `root` or `true` stay in the text.
 *
 * It does not reverse hex, compression or encryption, and does not find a value split across two
 * lines. A secret stored after the redactor was made is not known to it.
 */
export interface CredentialRedactor {
  /** The shortest value searched for. */
  readonly minValueLength: number
  /** `text` with every credential this redactor knows removed. */
  redact(text: string): string
  /**
   * A redactor for text arriving in pieces. It releases text a line at a time, so a credential
   * cut between two pieces is still found; the joined output equals `redact` over the joined input.
   */
  stream(): StreamRedactor
}

export interface CredentialRedactorOptions {
  /**
   * Credentials the caller knows of beside the stored ones, such as a password typed into its own
   * node's data. Searched for like a stored value.
   */
  values?: Iterable<string>
}

/**
 * A redactor over the values every Secrets Store on the instance holds, plus `options.values`.
 * The stored values never leave the host. A stored row the instance's key cannot decrypt is
 * skipped: nothing on this instance can resolve it to a value either. Throws when the stores
 * cannot be read, so a caller that cannot establish what to hide does not go on to show it.
 */
export declare function credentialRedactor(options?: CredentialRedactorOptions): Promise<CredentialRedactor>

/**
 * The `nodeCredentialProperties` export: per bare node type, the data properties that hold a
 * credential although their name does not say so (an htpasswd line, a connection string). A node
 * read shows a value typed into one as `[redacted]`, at any depth of the node's data, and returns
 * a `secret:<NAME>` reference as it is. Properties named like a credential (`password`,
 * `apiKey`, `token`, …) need no declaration.
 */
export type NodeCredentialProperties = Record<string, readonly string[]>
