/** `@opencroft/server/secrets` — the encrypted Secrets Store. */

/** A stored secret with its decrypted value. */
export interface SecretRecord {
  id: string
  storeId: string
  key: string
  value: string
  updatedAt: Date
}

/** Read/write access to the encrypted Secrets Store. Values cross this API as plaintext. */
export interface HostSecretsApi {
  /** Resolve a secret value by key across every store (oldest match wins); null if absent. */
  resolve(key: string): Promise<string | null>
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
  /** Create or update a secret value. */
  set(storeId: string, key: string, value: string): Promise<void>
  /** Delete a secret within a store. */
  delete(storeId: string, key: string): Promise<void>
  /** Delete a secret by its id. */
  deleteById(id: string): Promise<void>
}

export declare const secrets: HostSecretsApi
