/**
 * Server-side host API available to an extension's server module. The runtime
 * is injected by the host; these are the type declarations.
 */

import type * as nodeFs from 'node:fs'
import type * as nodeOs from 'node:os'
import type * as nodePath from 'node:path'

import type { ExecOptions, ExecResult, ServerConfig, TerminalContext } from '@opencroft/terminal'
// Type-only: the job shapes live with the implementation, on the server entry. Nothing runtime
// crosses this import, and duplicating them here would be a second definition to drift.
import type { JobSession, JobSessionOptions } from '@opencroft/terminal/server'

export type { ExecOptions, ExecResult, JobSession, JobSessionOptions, ServerConfig, TerminalContext }

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
  /**
   * Create a node on the graph at `address` — a space slug (its default graph)
   * or `<space>.<graph>`. Required: there is no default graph to fall back to.
   */
  createNode(
    address: string,
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

/** What a SendMessage node's `send` delivered to -- a group-chat thread, the only destination it routes to. `status` says whether the message queued behind a running turn or was delivered immediately. */
export interface HostSendMessageResult {
  kind: 'thread'
  threadRef: string
  status: 'queued' | 'delivered'
}

/** Deliver through a SendMessage node's own path -- the same membership-gated thread delivery its `text-in` wiring uses. */
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
}

/** A group chat as the bound sender sees it: its address, name and agent members. */
export interface HostGroupChat {
  /** The chat's id — accepted wherever a chat is named, as is its slug. */
  ref: string
  /** The chat's slug: what `EmbeddedAgentChat` takes as `space`. */
  slug: string
  name: string
  agents: Array<{ nodeId: string; name: string }>
}

/** A thread as the bound sender sees it. `threadId` is what `EmbeddedAgentChat` takes as `thread.threadId`. */
export interface HostGroupChatThread {
  /** Opaque thread reference: store it, pass it back. */
  ref: string
  threadId: string
  title: string | null
  chat: { ref: string; slug: string; name: string }
  agent: { nodeId: string; name: string | null }
  createdAt: Date
}

/** One turn of a thread's session, summarised — the same shape `group_chat_turns` returns. */
export interface HostThreadTurn {
  index: number
  prompt: string
  promptLength: number
  status: 'finished' | 'in-progress' | 'interrupted' | 'unknown'
  finalMessage?: string
  finalMessageLength?: number
}

export interface HostThreadTurnsPage {
  turns: HostThreadTurn[]
  hasMore: boolean
  nextBeforeIndex: number | null
  sessionStatus: string
}

/**
 * Group chats, acting as ONE sender the host chose: inside an App action
 * invoked by an agent (`ctx.groupChats`), that agent; everywhere else
 * (`host.groupChats`, or an action nobody's agent called), the extension's own
 * system identity `system.ext.<extension id, dotted>` — e.g.
 * `system.ext.local.task-pipelines`. There is no way to name another sender.
 *
 * Every call is gated on that sender's membership of the chat, exactly as an
 * agent's group-chat tools are; a system identity is a member once a person
 * grants it in the chat's members list. A chat or thread the sender cannot
 * reach refuses with "Not available", whichever of the two it was.
 *
 * A system identity may open threads and post; it cannot read transcripts.
 * Reading is `HostAgentGroupChatsApi.turns`, offered only when an agent is the
 * sender and so only over chats that agent belongs to.
 */
export interface HostGroupChatsApi {
  /** Chats the sender is a member of, with their agent members. */
  list(): Promise<HostGroupChat[]>
  /** Open a thread addressed to an agent member of `chat` (id or slug), with `message` as its first message from the sender. */
  startThread(input: {
    chat: string
    agentNodeId: string
    message: string
    title?: string
    folder?: string
  }): Promise<{ thread: HostGroupChatThread; folder: string | null }>
  /** Send into a thread; `queue` defaults to `wait` (after the running turn). */
  send(input: { thread: string; message: string; queue?: 'wait' | 'push' }): Promise<{ status: 'queued' | 'delivered' }>
  thread(ref: string): Promise<HostGroupChatThread>
}

/** `groupChats` acting as the agent that invoked an App action: the same calls, plus reading. */
export interface HostAgentGroupChatsApi extends HostGroupChatsApi {
  /** The thread's recent turns, newest last; page back with `beforeIndex` from the previous page. */
  turns(ref: string, page?: { turns?: number; beforeIndex?: number }): Promise<HostThreadTurnsPage>
}

export interface HostExecContextApi {
  /** Dispatch an execution-context event to every target connected to `sourceHandleId` on `sourceNodeId` (broadcast). `primary`'s shape is caller-defined -- narrow it at the call site. */
  dispatch(
    sourceNodeId: string,
    sourceHandleId: string,
    event: unknown,
  ): Promise<{ primary: unknown; results: unknown[] }>
}

/** One of an agent node's MCP tokens, as listed. Dates are ISO strings; a null `expiresAt` never expires. The token itself is not here and cannot be read back. */
export interface HostMcpTokenInfo {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}

/**
 * The credentials that identify an agent node on the MCP endpoint. A token is
 * issued to one agent node and authenticates as that agent there and nowhere
 * else. Calls are not authorised here -- whatever invokes these must already
 * have established a signed-in person, because issuing a token is issuing an
 * agent's identity.
 */
export interface HostMcpTokensApi {
  /** The node's tokens, newest first. */
  list(agentNodeId: string): Promise<HostMcpTokenInfo[]>
  /** Issue a token; `expiresAt` null means it never expires. The plaintext `token` is returned here once and never again. Refused when the node is not an agent. */
  create(agentNodeId: string, input: { name: string; expiresAt: string | null }): Promise<{ id: string; token: string }>
  /** Delete one of the node's tokens. It stops working on the next request that presents it. */
  delete(agentNodeId: string, id: string): Promise<void>
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
  /** Group chats as this extension's own system identity — see HostGroupChatsApi. */
  groupChats: HostGroupChatsApi
  mcpTokens: HostMcpTokensApi
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
    /**
     * Start a command as a watchable session and get back the key a client attaches to. Use this
     * when the output has to appear WHILE the command runs; `execResult` is the right call when
     * only the outcome matters.
     *
     * **It adds no reach that `exec` and `run` do not already have.** The command is chosen by your
     * server code either way. What differs is delivery: instead of one result at the end, output
     * goes to a terminal session as it arrives, and the returned `sessionKey` is what authorises
     * attaching to that session.
     *
     * **So treat the key as the secret it is.** It is the entire authorisation to watch the job —
     * return it in the action's response to the client that asked, and do not write it into node
     * data or anywhere else a browser can read without having asked.
     *
     * A context with no non-pty streaming channel — anything but `local` and `ssh` today — is
     * refused by rejection, before a key exists. So a rejection means nothing started and there is
     * nothing for you to clean up.
     */
    startJob(ctx: TerminalContext, opts: JobSessionOptions): Promise<JobSession>
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
export declare const groupChats: ExtensionServerHost['groupChats']
export declare const execContext: ExtensionServerHost['execContext']
export declare const events: ExtensionServerHost['events']
export declare const openclaw: ExtensionServerHost['openclaw']
export declare const terminal: ExtensionServerHost['terminal']
export declare const ssh: ExtensionServerHost['ssh']
export declare const extensionId: string
