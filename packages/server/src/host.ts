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

/**
 * The graph, across every space. Nodes come back with the type graphs store:
 * qualified with the declaring extension's id, `<owner>.<extension>.<type>`. A
 * type passed in is either one of this extension's own, bare, or any
 * extension's, qualified.
 */
export interface HostGraphApi {
  listNodes(): Promise<GraphNodeRecord[]>
  getNode(nodeId: string): Promise<GraphNodeRecord | null>
  listNodesByType(type: string): Promise<GraphNodeRecord[]>
  listEdges(): Promise<unknown[]>
  updateNode(nodeId: string, patch: Partial<GraphNodeRecord>): Promise<GraphNodeRecord | null>
  /**
   * Create a node on the graph at `address` — a space slug (its default graph)
   * or `<space>.<graph>`. Required: there is no default graph to fall back to.
   */
  createNode(
    address: string,
    type: string,
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
  /** True while the thread is archived: it refuses every send until unarchived. */
  archived: boolean
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

/** One finished turn of a thread's session, as its usage record has it. */
export interface HostThreadUsageTurn {
  /** When the turn ended, ISO. */
  endedAt: string
  /** The model the turn ran on, when the harness named it. */
  model: string | null
  /** The turn's own token spend — this turn's, not a running total — including what its subagents spent. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  /** The turn's own cost; null when the harness does not price the session. */
  cost: { amount: number; currency: string } | null
}

/** How much context a thread's session holds. */
export interface HostThreadContext {
  usedTokens: number
  /** The model's window; null when it cannot be named. */
  contextLimit: number | null
  /** When the reading was taken, ISO, for a session not loaded now; absent for a live reading. */
  asOf?: string
}

/**
 * What a thread has spent: its recorded turns, oldest first, and whether a
 * turn is running now (its spend then arrives when that turn ends). `context`
 * is what its session holds now, or last held; null when it never reported.
 */
export interface HostThreadUsage {
  turns: HostThreadUsageTurn[]
  busy: boolean
  context: HostThreadContext | null
}

/**
 * How a compaction asked for with `groupChats.compact` ended.
 * `compacted`: the session's context shrank. `not_compacted`: it did not (a
 * harness without compaction answers it as a message). `unknown`: there was
 * no reading to tell by. `failed`: the compaction errored. `timed_out`: it was
 * still waiting or running when the wait ended; it carries on regardless.
 */
export interface HostCompactResult {
  outcome: 'compacted' | 'not_compacted' | 'unknown' | 'failed' | 'timed_out'
  /** Context tokens around the compaction alone; null when not read. */
  contextBefore: number | null
  contextAfter: number | null
  /** Why it failed, for `failed`. */
  error?: string
}

export interface HostThreadTurnsPage {
  turns: HostThreadTurn[]
  hasMore: boolean
  nextBeforeIndex: number | null
  sessionStatus: string
}

/** How often a session's agent reads what is sent to it — the chat command bar's Presence control. */
export type HostPresence =
  | { kind: 'high-attention' }
  | { kind: 'realtime' }
  | { kind: 'online' }
  | { kind: 'minutes' }
  | { kind: 'hourly' }
  | { kind: 'daily' }
  | { kind: 'custom'; intervalMs: number }

/**
 * Settings for a thread's session, applied before the message they ride with
 * is delivered — the chat command bar's Effort, Presence and Permission Mode
 * controls, in the command bar's own vocabulary. Each is optional: one left
 * out leaves the session's current setting as it is.
 */
export interface HostSessionOptions {
  /** Reasoning effort: `max`, `extra`, `high`, `medium`, `low`, `default` or `off`. */
  effort?: string
  presence?: HostPresence
  /** `auto`, `plan`, `manual-edits`, `accept-edits`, `reject-edits` or `bypass`. */
  permissionMode?: string
}

/**
 * What became of the session options a call carried. A value the session's
 * agent does not offer (an effort level its model lacks, a permission mode its
 * harness has no such thing as) is skipped with the reason, and the others
 * still apply: an option never fails the call it rides with.
 */
export interface HostSessionOptionsResult {
  applied: Array<keyof HostSessionOptions>
  skipped: Array<{ option: keyof HostSessionOptions; reason: string }>
}

/**
 * Group chats, acting as ONE sender the host chose: inside an App action
 * invoked by an agent (`ctx.groupChats`), that agent; everywhere else
 * (`host.groupChats`, or an action nobody's agent called), the extension's own
 * system identity `system.ext.<extension id, dotted>` — e.g.
 * `system.ext.acme.task-pipelines`. There is no way to name another sender.
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
  /**
   * Open a thread addressed to an agent member of `chat` (id or slug), with
   * `message` as its first message from the sender. `sessionOptions` are
   * applied to the thread's session before that message is delivered, and
   * the result says what became of them (present only when they were given).
   */
  startThread(input: {
    chat: string
    agentNodeId: string
    message: string
    title?: string
    folder?: string
    sessionOptions?: HostSessionOptions
  }): Promise<{ thread: HostGroupChatThread; folder: string | null; sessionOptions?: HostSessionOptionsResult }>
  /**
   * Send into a thread; `queue` defaults to `wait` (after the running turn).
   * `sessionOptions` are applied to the thread's session before the message
   * is delivered or queued, as for `startThread`.
   */
  send(input: {
    thread: string
    message: string
    queue?: 'wait' | 'push'
    sessionOptions?: HostSessionOptions
  }): Promise<{ status: 'queued' | 'delivered'; sessionOptions?: HostSessionOptionsResult }>
  thread(ref: string): Promise<HostGroupChatThread>
  /**
   * Archive a thread the sender owns — one it started, or for an agent sender
   * one addressed to it. The thread keeps its history and its folder, moves to
   * the chat's archive, and refuses every send (`send` included) until it is
   * unarchived. Already archived: nothing changes. Any other thread refuses
   * with "Not available".
   */
  archive(ref: string): Promise<HostGroupChatThread>
  /** Bring an archived thread back into the chat's thread list, into the folder it has in the archive. Same gate as `archive`. */
  unarchive(ref: string): Promise<HostGroupChatThread>
  /**
   * The usage of a thread THIS extension opened (through `startThread`, as its
   * own system identity): its turns' tokens and cost, optionally only turns
   * that ended at or after `since` (ISO). Numbers only — never the transcript.
   * Any other thread, or one in a chat the extension is no longer a member
   * of, refuses with "Not available", whoever the sender is.
   */
  usage(ref: string, options?: { since?: string }): Promise<HostThreadUsage>
  /**
   * Compact the session of a thread THIS extension opened, and resolve once
   * the compaction has ended or the wait for it gave up. The compaction runs
   * after any turn in progress, and on success the thread's standing context
   * is re-delivered, as `group_chat_compact` does. Send the next message after
   * this resolves: one sent before it can be read before the compaction.
   * An archived thread, or one whose agent left the chat, is refused; any
   * other thread refuses with "Not available", as for `usage`.
   */
  compact(ref: string): Promise<HostCompactResult>
}

/** `groupChats` acting as the agent that invoked an App action: the same calls, plus reading. */
export interface HostAgentGroupChatsApi extends HostGroupChatsApi {
  /** The thread's recent turns, newest last; page back with `beforeIndex` from the previous page. */
  turns(ref: string, page?: { turns?: number; beforeIndex?: number }): Promise<HostThreadTurnsPage>
}

/** A chat the signed-in person belongs to, and whether this extension may already deliver into it. */
export interface HostPersonGroupChat extends HostGroupChat {
  /** Whether this extension's own system identity is a member — the grant `grantExtension` makes. */
  extensionGranted: boolean
}

/**
 * `groupChats` for an App action a signed-in person invoked from the App's UI.
 * Sending is unchanged — the inherited calls act as the extension's own system
 * identity, as they do for any call no agent made — and two calls act as the
 * PERSON, so a UI can offer the person's own chats and let them grant this
 * extension into one.
 */
export interface HostPersonGroupChatsApi extends HostGroupChatsApi {
  /** The chats the person is a member of, with their agent members and the extension's grant state. */
  personChats(): Promise<HostPersonGroupChat[]>
  /**
   * Add this extension's own system identity to `chat` (id or slug) as a
   * member, acting as the person through the chat's members gate: refused
   * with "Not available" when the person is not a member of it. It can grant
   * nothing else — no other principal can be named.
   */
  grantExtension(chat: string): Promise<void>
}

/** One person in the user directory. Three fields by design: never an email, role or sign-in state. */
export interface HostUser {
  id: string
  name: string
  avatarUrl: string | null
}

/** The people directory — what any signed-in member may already see of every account. */
export interface HostUsersApi {
  /** Every account, ordered by name. */
  list(): Promise<HostUser[]>
}

/** One agent in the agent directory: its node id, name and avatar — the ones the group chat shows. Nothing else. */
export interface HostAgent {
  id: string
  name: string
  avatarUrl: string | null
}

/** The agent directory — every Agent node of every space, the agents' counterpart of `HostUsersApi`. */
export interface HostAgentsApi {
  /** Every agent, ordered by name. */
  list(): Promise<HostAgent[]>
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
  /** The extension's own id, `<owner>.<extension>`. Never hard-code it. */
  extensionId: string
  /**
   * Where the host serves this extension: `/api/ext/<extensionId>`. Extensions
   * never build their own URLs — use this, `assetUrl`, `routeUrl` and
   * `absoluteUrl`, so a link stays right when the extension is served under
   * another folder or the URL scheme changes.
   */
  urlBase: string
  /** The URL of a static file under the extension's `assets/` folder. */
  assetUrl(path: string): string
  /** The URL of one of the extension's declared HTTP `routes` (see `ExtensionRoute`). */
  routeUrl(path: string): string
  /**
   * An instance-relative URL (`urlBase`, or what `assetUrl` / `routeUrl`
   * return) in absolute form, for a link handed outside the instance: a
   * webhook target, a registry entry in another project's config.
   *
   * There is no instance-origin setting, so the origin is the one `request`
   * arrived on — pass the request the handler is answering. From code with no
   * request in hand, keep the relative URL and let the client make it
   * absolute (the client's `absoluteUrl` uses the page's origin).
   */
  absoluteUrl(request: Request, url?: string): string
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
  /** The people directory: id, name and avatar of every account — see HostUsersApi. */
  users: HostUsersApi
  /** The agent directory: id, name and avatar of every agent — see HostAgentsApi. */
  agents: HostAgentsApi
  mcpTokens: HostMcpTokensApi
  execContext: HostExecContextApi
  /**
   * Fire-and-forget push to all connected clients; received in extension
   * client code via getStream(extensionId, 'events').
   */
  events: { broadcast: (name: string, payload?: Record<string, unknown>) => void }
  /** Documents several people edit at once -- see HostCollabApi. */
  collab: HostCollabApi
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
    /**
     * Stop a job you started with `stopWhenUnwatchedMs` (a job that exists only to be watched)
     * now, rather than when that bound runs out. Call it when your client is done with the view:
     * the tab showing it was closed, or it was replaced by another one. Until then every view holds
     * one of the ten job slots, so a client that lets go of views without this can fill them.
     *
     * A view that has already ended or been reclaimed is not an error. Any other job is refused
     * with a throw: a job started without the option, such as a deploy, is not stopped because a
     * viewer left.
     */
    stopViewJob(sessionKey: string): void
  }
  ssh: {
    exec(config: ServerConfig, command: string): Promise<string>
    resolveKey(keyPath?: string): Promise<string | undefined>
  }
}

/** One added App instance, as reported to the providing extension. */
export interface HostAppInstance {
  instanceId: string
  /** The App this is an instance of, by the bare type this extension declared it under — its key in `apps`. */
  type: string
  /** @deprecated Read `type`, which holds the same bare value. */
  appSlug: string
  spaceSlug: string
  /** The instance's display name — the host's field, required at add time. */
  name: string
  /** The instance's slug — unique in its space; `<spaceSlug>.<slug>` is its address. */
  slug: string
  params: Record<string, string>
  /** Absolute path of the instance's private data directory. */
  dataDir: string
}

/** Where one kind of an extension's markdown documents is stored, keyed by whatever the extension keys them by. */
export interface HostMarkdownDocStorage {
  /** The document's markdown as stored; null when there is no such document. */
  read(key: string): Promise<string | null>
  /** Stores the document's markdown. */
  write(key: string, markdown: string): Promise<void>
  /** Whether a signed-in person may open the document; when absent, everyone signed in may. */
  authorize?(key: string, user: { id: string; name: string }): Promise<boolean> | boolean
}

/** Who changed a markdown document from outside an editor, as the change is shown to the people editing it. */
export interface HostMarkdownEditOrigin {
  kind: 'agent' | 'user'
  name: string
}

/**
 * Documents several people edit at once, in the host's `MarkdownEditor`: a
 * document's markdown stays where the extension keeps it, and while anyone
 * has it open the host holds the shared copy, with everyone's carets, and
 * writes the markdown back. A document nobody has changed is never rewritten
 * for being opened.
 */
export interface HostCollabApi {
  markdown: {
    /** Serves the extension's documents of `kind` -- a name of its own, without a colon -- from `storage`. Call it from `load`. */
    register(kind: string, storage: HostMarkdownDocStorage): void
    /** What the extension's UI hands `MarkdownEditor` to open a document: `collab={{ document }}`. */
    documentName(kind: string, key: string): string
    /** A document's markdown as it stands: the open copy's when it is open, the stored markdown otherwise. */
    read(kind: string, key: string): Promise<string | null>
    /**
     * Changes a document's markdown as `origin`: `change` is handed the
     * markdown as it stands and returns what it should be. An open document is
     * changed in place -- what people type meanwhile survives, and every editor
     * shows the change being made -- and the change is stored before this
     * returns. Returns the new markdown.
     */
    edit(
      kind: string,
      key: string,
      origin: HostMarkdownEditOrigin,
      change: (markdown: string) => string,
    ): Promise<string>
    /** Stores now what the open documents of `kind` hold -- or only `key`'s -- rather than shortly. */
    flush(kind: string, key?: string): Promise<void>
    /**
     * Runs `change` -- a change to the storage of the documents of `kind`, or
     * of the ones `keys` names -- while none of them is open. Each open one is
     * stored first, unless `discard` drops what it holds; editors reconnect to
     * the markdown as `change` left it.
     */
    whileClosed<T>(
      kind: string,
      keys: string[] | null,
      change: () => Promise<T>,
      options?: { discard?: boolean },
    ): Promise<T>
  }
}

export interface HostAppsApi {
  /** The calling extension's added App instances, oldest first; optionally one App's only, named by its bare type. */
  listInstances(type?: string): Promise<HostAppInstance[]>
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
export declare const users: ExtensionServerHost['users']
export declare const execContext: ExtensionServerHost['execContext']
export declare const events: ExtensionServerHost['events']
export declare const collab: ExtensionServerHost['collab']
export declare const openclaw: ExtensionServerHost['openclaw']
export declare const terminal: ExtensionServerHost['terminal']
export declare const ssh: ExtensionServerHost['ssh']
export declare const extensionId: ExtensionServerHost['extensionId']
export declare const urlBase: ExtensionServerHost['urlBase']
export declare const assetUrl: ExtensionServerHost['assetUrl']
export declare const routeUrl: ExtensionServerHost['routeUrl']
export declare const absoluteUrl: ExtensionServerHost['absoluteUrl']
