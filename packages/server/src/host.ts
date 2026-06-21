/**
 * Server-side host API available to an extension's server module. The runtime
 * is injected by the host; these are the type declarations.
 */

import type * as nodeFs from 'node:fs'
import type * as nodeOs from 'node:os'
import type * as nodePath from 'node:path'

import type { ServerConfig, TerminalContext } from '@opencroft/terminal'

export type { ServerConfig, TerminalContext }

export interface GraphNodeRecord {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

export interface HostGraphApi {
  listNodes(): Promise<GraphNodeRecord[]>
  getNode(nodeId: string): Promise<GraphNodeRecord | null>
  listNodesByType(typeId: string): Promise<GraphNodeRecord[]>
  listEdges(): Promise<unknown[]>
  updateNode(nodeId: string, patch: Partial<GraphNodeRecord>): Promise<GraphNodeRecord | null>
  createNode(
    typeId: string,
    data: Record<string, unknown>,
    position: { x: number; y: number },
  ): Promise<GraphNodeRecord>
  deleteNode(nodeId: string): Promise<void>
}

export interface ExtensionStorageApi {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

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
  /** List every secret across all stores, most-recently-updated first. */
  listAll(): Promise<SecretRecord[]>
  /** Create or update a secret value. */
  set(storeId: string, key: string, value: string): Promise<void>
  /** Delete a secret within a store. */
  delete(storeId: string, key: string): Promise<void>
  /** Delete a secret by its id. */
  deleteById(id: string): Promise<void>
}

export interface ExtensionServerHost {
  extensionId: string
  fs: typeof nodeFs.promises
  os: typeof nodeOs
  path: typeof nodePath
  exec(cmd: string): Promise<string>
  execFile(cmd: string, args: string[]): Promise<string>
  cacheDir(...parts: string[]): string
  crypto: { encrypt(value: string): string; decrypt(value: string): string; randomToken(bytes?: number): string }
  settings: { get(...args: unknown[]): Promise<unknown>; set(...args: unknown[]): Promise<unknown> }
  graph: HostGraphApi
  storage: ExtensionStorageApi
  secrets: HostSecretsApi
  openclaw: { call<T = unknown>(method: string, params?: object): Promise<T> }
  terminal: {
    exec(ctx: TerminalContext, command: string): Promise<string>
    run(ctx: TerminalContext, args: string[], env?: Record<string, string>): Promise<string>
    /** Resolve a terminal context from a node's output handle ("node-id" + "handle-id"). */
    getContext(nodeId: string, handleId: string): Promise<TerminalContext>
  }
  ssh: {
    exec(config: ServerConfig, command: string): Promise<string>
    resolveKey(keyPath?: string): Promise<string | undefined>
  }
}

declare const host: ExtensionServerHost
export default host

export declare const fs: ExtensionServerHost['fs']
export declare const os: ExtensionServerHost['os']
export declare const path: ExtensionServerHost['path']
export declare const exec: ExtensionServerHost['exec']
export declare const execFile: ExtensionServerHost['execFile']
export declare const cacheDir: ExtensionServerHost['cacheDir']
export declare const crypto: ExtensionServerHost['crypto']
export declare const settings: ExtensionServerHost['settings']
export declare const graph: ExtensionServerHost['graph']
export declare const storage: ExtensionServerHost['storage']
export declare const secrets: ExtensionServerHost['secrets']
export declare const openclaw: ExtensionServerHost['openclaw']
export declare const terminal: ExtensionServerHost['terminal']
export declare const ssh: ExtensionServerHost['ssh']
export declare const extensionId: string
