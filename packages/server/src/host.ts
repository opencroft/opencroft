/**
 * Server-side host API available to an extension's server module. The runtime
 * is injected by the host; these are the type declarations.
 */

import type * as nodeFs from 'node:fs'
import type * as nodeOs from 'node:os'
import type * as nodePath from 'node:path'

import type { ExecOptions, ExecResult, ServerConfig, TerminalContext } from '@opencroft/terminal'

export type { ExecOptions, ExecResult, ServerConfig, TerminalContext }

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

/** `null` means unknown (offline session, no turn completed yet, or a harness that doesn't report usage) -- never "nothing held". */
export interface HostContextUsage {
  usedTokens: number
  contextLimit: number | null
}

export interface HostSessionSummary {
  sessionKey: string
  agent: string
  job: string
  title: string
  createdAt: number
  lastActivityAt: number
  status: 'offline' | 'idle' | 'working' | 'waiting'
  contextUsage: HostContextUsage | null
}

export interface HostTurnSummary {
  index: number
  prompt: string
  promptLength: number
  status: 'finished' | 'in-progress' | 'interrupted' | 'unknown'
  finalMessage?: string
  finalMessageLength?: number
}

export interface HostTurnsPage {
  turns: HostTurnSummary[]
  hasMore: boolean
  nextBeforeIndex: number | null
  sessionStatus: 'offline' | 'idle' | 'working' | 'waiting'
}

export interface HostCompactResult {
  sessionKey: string
  contextUsageBefore: HostContextUsage | null
  contextUsageAfter: HostContextUsage | null
  compacted: boolean | null
  instructionsRestored: boolean
}

/** Returned immediately by `compact` -- the compaction itself runs in the background; poll `compactStatus` for the outcome. */
export interface HostCompactAck {
  sessionKey: string
  accepted: true
  coalesced: boolean
  state: 'pending' | 'running'
}

export interface HostCompactStatus {
  sessionKey: string
  state: 'never-requested' | 'pending' | 'running' | 'done' | 'error'
  requestedAt?: number
  startedAt?: number
  finishedAt?: number
  result?: HostCompactResult
  error?: string
}

/** What a SendMessage node's `send` actually delivered to -- an agent:job session (unchanged) or a group-chat thread (mutually exclusive `thread` field in the payload). */
export type HostSendMessageResult =
  | { kind: 'agent'; sessionKey: string; created: boolean; forced: boolean }
  | { kind: 'thread'; threadRef: string; status: 'queued' | 'delivered' }

/** Deliver through a SendMessage node's own path (session reuse/create, envelope composition) -- the same mechanism its `text-in` wiring uses. */
export interface HostSendMessageApi {
  /**
   * `sourceNodeId` is what fed THIS run, taken from the action context's input
   * source rather than from a graph lookup: several things can be wired to one
   * handle and only the run knows which of them fired. The message is
   * attributed to it, and a send whose source cannot be turned into an account
   * is refused rather than attributed to the application.
   *
   * `callerAgent` is who INVOKED the action, from `ctx.callerAgent`, and it is
   * consulted only when nothing fed the run -- an action a caller triggered
   * directly has no upstream node by definition, and that is not the same fact
   * as having no sender. Pass both and let the host choose; a run with neither
   * is still refused.
   */
  send(
    nodeId: string,
    payload: Record<string, unknown>,
    sourceNodeId: string | undefined,
    callerAgent?: string,
  ): Promise<HostSendMessageResult>
  listAgents(nodeId: string): Promise<{ agent: string; jobs: string[] }[]>
  listSessions(nodeId: string, params: { agent?: string; job?: string }): Promise<HostSessionSummary[]>
  listTurns(
    nodeId: string,
    params: { sessionKey: string; turns?: number; beforeIndex?: number },
  ): Promise<HostTurnsPage>
  /** Returns immediately -- never blocks for the compaction itself. */
  compact(nodeId: string, params: { sessionKey: string }): Promise<HostCompactAck>
  compactStatus(nodeId: string, params: { sessionKey: string }): Promise<HostCompactStatus>
  /** Terminates an idle session's process; the transcript and durable session pointer are kept, so the next message reloads it transparently (same cold-start resume an offline session already uses). */
  unload(nodeId: string, params: { sessionKey: string }): Promise<{ sessionKey: string; unloaded: true }>
  /**
   * Removes a session for good: drops its durable session pointer (and any
   * config overrides) AND its chat-list entry, so it no longer resumes and no
   * longer appears in the sidebar. Default requires `status` (see
   * listSessions) to be `offline` -- deleting a live session would silently
   * drop whatever it's doing, so `idle`/`working`/`waiting` are refused unless
   * `force: true`, which first ends the live process (same teardown as a live
   * chat delete) and then proceeds. The underlying harness's on-disk
   * transcript is deliberately left alone and NOT located or deleted -- this
   * stays harness-agnostic, the same boundary agentClient.loadSession
   * observes, and the harness may be running on a different terminal context
   * (local/WSL/SSH) than this server; the transcript is orphaned, not lost
   * track of.
   */
  delete(
    nodeId: string,
    params: { sessionKey: string; force?: boolean },
  ): Promise<{ sessionKey: string; deleted: true }>
}

export interface HostExecContextApi {
  /** Dispatch an execution-context event to every target connected to `sourceHandleId` on `sourceNodeId` (broadcast). `primary`'s shape is caller-defined -- narrow it at the call site. */
  dispatch(
    sourceNodeId: string,
    sourceHandleId: string,
    event: unknown,
  ): Promise<{ primary: unknown; results: unknown[] }>
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

export interface ExtensionServerHost {
  extensionId: string
  fs: typeof nodeFs.promises
  os: typeof nodeOs
  path: typeof nodePath
  exec(cmd: string): Promise<string>
  execFile(cmd: string, args: string[]): Promise<string>
  cacheDir(...parts: string[]): string
  /** Persistent per-extension data directory. Unlike cacheDir, this is not wiped and is safe for durable state such as git clones. */
  dataDir(...parts: string[]): string
  crypto: {
    encrypt(value: string): string
    decrypt(value: string): string
    randomToken(bytes?: number): string
    /** CSPRNG-uniform random string of `length` characters drawn from `charset`. */
    randomString(length: number, charset: string): string
  }
  settings: { get(...args: unknown[]): Promise<unknown>; set(...args: unknown[]): Promise<unknown> }
  graph: HostGraphApi
  storage: ExtensionStorageApi
  secrets: HostSecretsApi
  /** The calling extension's own added App instances (see `AppsExport` in this package). */
  apps: HostAppsApi
  sendMessage: HostSendMessageApi
  execContext: HostExecContextApi
  /**
   * Fire-and-forget push to all connected clients; received in extension
   * client code via getStream(extensionId, 'events').
   */
  events: { broadcast: (name: string, payload?: Record<string, unknown>) => void }
  openclaw: { call<T = unknown>(method: string, params?: object): Promise<T> }
  terminal: {
    exec(ctx: TerminalContext, command: string): Promise<string>
    run(ctx: TerminalContext, args: string[], env?: Record<string, string>): Promise<string>
    execResult(ctx: TerminalContext, command: string, opts?: ExecOptions): Promise<ExecResult>
    runResult(ctx: TerminalContext, args: string[], opts?: ExecOptions): Promise<ExecResult>
    /** Resolve a terminal context from a node's output handle ("node-id" + "handle-id"). */
    getContext(nodeId: string, handleId: string): Promise<TerminalContext>
  }
  ssh: {
    exec(config: ServerConfig, command: string): Promise<string>
    resolveKey(keyPath?: string): Promise<string | undefined>
  }
}

/** One added App instance, as reported to the providing extension. */
export interface HostAppInstance {
  instanceId: string
  appSlug: string
  spaceSlug: string
  params: Record<string, string>
  /** Absolute path of the instance's private data directory. */
  dataDir: string
}

export interface HostAppsApi {
  /** The calling extension's added App instances, oldest first; optionally one App's only. */
  listInstances(appSlug?: string): Promise<HostAppInstance[]>
}

declare const host: ExtensionServerHost
export default host

export declare const fs: ExtensionServerHost['fs']
export declare const os: ExtensionServerHost['os']
export declare const path: ExtensionServerHost['path']
export declare const exec: ExtensionServerHost['exec']
export declare const execFile: ExtensionServerHost['execFile']
export declare const cacheDir: ExtensionServerHost['cacheDir']
export declare const dataDir: ExtensionServerHost['dataDir']
export declare const crypto: ExtensionServerHost['crypto']
export declare const settings: ExtensionServerHost['settings']
export declare const graph: ExtensionServerHost['graph']
export declare const storage: ExtensionServerHost['storage']
export declare const secrets: ExtensionServerHost['secrets']
export declare const apps: ExtensionServerHost['apps']
export declare const sendMessage: ExtensionServerHost['sendMessage']
export declare const execContext: ExtensionServerHost['execContext']
export declare const events: ExtensionServerHost['events']
export declare const openclaw: ExtensionServerHost['openclaw']
export declare const terminal: ExtensionServerHost['terminal']
export declare const ssh: ExtensionServerHost['ssh']
export declare const extensionId: string
