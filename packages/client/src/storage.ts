/**
 * `@opencroft/client/storage` — the extension's key-value store, the same one
 * its server half reaches as `storage`.
 */

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

/** The extension's store; keys under `namespace` are stored as `<namespace>::<key>`. */
export declare const createStorage: (namespace?: string) => ExtensionStorage
