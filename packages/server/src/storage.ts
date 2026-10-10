/**
 * `@opencroft/server/storage` — where an extension keeps its state: its
 * key-value store (the one its client half reaches with `createStorage`), and
 * its cache and data directories.
 */

export interface ExtensionStorageApi {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

/** The extension's key-value store. Works in actions, routes and lifecycle hooks alike. */
export declare const storage: ExtensionStorageApi

/** A path under the extension's cache directory, which may be wiped. */
export declare const cacheDir: (...parts: string[]) => string

/** A path under the extension's persistent data directory. Unlike `cacheDir`, safe for durable state such as git clones. */
export declare const dataDir: (...parts: string[]) => string
