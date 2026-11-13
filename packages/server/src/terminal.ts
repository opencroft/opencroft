/**
 * `@opencroft/server/terminal` — running commands in a terminal context (a
 * node's or App's terminal, local or over ssh), dispatching execution
 * contexts along the graph, and calling an action from a graph.
 */
import type {
  agentRefusalOf as AgentRefusalOf,
  ExecOptions,
  ExecResult,
  ServerConfig,
  TerminalContext,
} from '@opencroft/terminal'
// Type-only: the job shapes live with the implementation, on the server entry. Nothing runtime
// crosses this import, and duplicating them here would be a second definition to drift.
import type { JobSession, JobSessionOptions, SpawnedProcess, SpawnOptions } from '@opencroft/terminal/server'

export type {
  ExecOptions,
  ExecResult,
  JobSession,
  JobSessionOptions,
  ServerConfig,
  SpawnedProcess,
  SpawnOptions,
  TerminalContext,
}

export interface HostTerminalApi {
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
  /**
   * The file at `path` on the machine `ctx` reaches, as bytes. The bytes travel as the stdout of
   * a command run over the context's own channel, unencoded, so a large file costs only its
   * transfer, on every kind of terminal. A relative `path` is resolved from the context's working
   * directory. Refused past `maxBytes`, by default 256 MiB, since the file is held in memory whole.
   */
  readFile(ctx: TerminalContext, path: string, opts?: { maxBytes?: number }): Promise<Buffer>
  /**
   * Writes `data` to `path` on the machine `ctx` reaches, creating its folder, and answers the path
   * it was written to. The bytes travel as a command's stdin into a temp file beside `path`, which
   * then takes the name, so a reader never sees half a file. When the name is taken, `ifExists`
   * says what happens: `overwrite` (the default) replaces the file, `fail` refuses, and `number`
   * writes the first free `<stem>-<n><ext>` beside it (`photo.png` → `photo-1.png`). `fail` and
   * `number` claim the name in one step, so two writes never take the same one. The three are a
   * save's collision rules (`FileCollision` in `@opencroft/server/values`).
   */
  writeFile(
    ctx: TerminalContext,
    path: string,
    data: Buffer,
    opts?: { ifExists?: 'overwrite' | 'fail' | 'number' },
  ): Promise<{ path: string }>
  /** The folders directly inside `path` on the machine `ctx` reaches, sorted by name, with `path` made absolute. */
  listFolders(ctx: TerminalContext, path: string): Promise<{ path: string; folders: string[] }>
  /**
   * Start `argv` on the machine `ctx` reaches with its stdin, stdout and stderr open for as long as
   * it runs, for code that talks to the process over them (a protocol over stdio). `env` reaches it
   * the way `run` delivers env on that context, never in the command line. Every kind of terminal
   * has it. The process is yours to end: `kill` it, or end its stdin when it stops on end of input.
   */
  spawn(ctx: TerminalContext, argv: string[], opts?: SpawnOptions): Promise<SpawnedProcess>
}

/** A key as a Key Store lists it: never its private half. */
export interface SshKeyRecord {
  name: string
  /** As `ssh-keygen -l` names it (`ED25519`, `RSA`, `ECDSA`), or `unknown`. */
  type: string
  /** `SHA256:…`, or empty when the private half could not be parsed. */
  fingerprint: string
  /** One authorized_keys line; null when the private half could not be parsed to derive it. */
  publicKey: string | null
}

/**
 * The keys of the Key Store nodes, kept by the host in its database with the private half
 * encrypted. No member returns a private half: `ssh.resolveKey` is the one way to read one, and
 * it is held to the store's graph.
 */
export interface HostSshKeysApi {
  /** The keys store `storeId` holds, by name. Decrypts nothing, so it lists while keys cannot be read. */
  list(storeId: string): Promise<SshKeyRecord[]>
  /** The key `name` of store `storeId`, or null when the store holds none. */
  get(storeId: string, name: string): Promise<SshKeyRecord | null>
  /**
   * Stores a keypair as key `name` of store `storeId`. `create` stores it only when the store
   * holds no key of that name, `replace` only when it does, in one write, so a reference to the
   * name never finds it missing. Answers whether it stored it. The type and fingerprint are read
   * from `privateKey`, and `publicKey` defaults to the half derived from it. Throws when
   * `privateKey` is not an SSH private key, when the SSH client cannot connect with it (a PKCS#8
   * key, or a key in any format with a passphrase), naming the conversion, and when the host
   * cannot encrypt keys.
   */
  put(
    storeId: string,
    name: string,
    key: { privateKey: string; publicKey?: string },
    mode: 'create' | 'replace',
  ): Promise<boolean>
  /** Deletes the key `name` of store `storeId`. Answers whether the store held it. */
  delete(storeId: string, name: string): Promise<boolean>
}

export interface HostSshApi {
  /** The Key Store nodes' keys. */
  keys: HostSshKeysApi
  exec(config: ServerConfig, command: string): Promise<string>
  /**
   * The private key `keyPath` names, undefined when it names none. A `<keyStoreNodeId>:<name>`
   * reference reads from that Key Store only when the store is on the graph of `scope.nodeId`, the
   * node the reference is stored on (a Server); a store anywhere else, or a call without a scope,
   * is refused with a throw. Any other value is read as a file path.
   */
  resolveKey(keyPath: string | undefined, scope: { nodeId: string }): Promise<string | undefined>
}

/**
 * What a call from a graph names as its target: one or more nodes of the
 * calling node's space, all of one type, called in order; or one App
 * instance, by its instance id (an address is read too, but moves on rename).
 */
export type GraphCallTarget = { nodes: string[] } | { app: string }

/** One action a target offers to a call from a graph. */
export interface GraphCallAction {
  id: string
  label: string
  description?: string
  /** The JSON schema of its parameters, as its manifest declares it. */
  inputSchema?: Record<string, unknown>
  /** Declared `admin` by its extension (`nodeActionAccess`): a graph never calls it. */
  admin: boolean
}

/** What a call from a node's graph may target: the nodes of its graph that have actions, and the apps of its space. */
export interface GraphCallTargets {
  nodes: {
    id: string
    name: string
    /** Qualified, as graphs store it. */
    type: string
    typeName: string
    icon?: string
    /** The names of the subgraphs the node is inside, outermost first; empty at the top level. */
    path: string[]
  }[]
  apps: { instanceId: string; address: string; name: string; type: string }[]
}

/** How `execContext.dispatch` runs its targets. */
export interface ExecDispatchOptions {
  /** What the source's run-time outputs answer from while its targets run; the event when left out. */
  run?: unknown
}

export interface HostExecContextApi {
  /**
   * Dispatch an execution-context event to every target connected to
   * `sourceHandleId` on `sourceNodeId` (broadcast). `primary`'s shape is
   * caller-defined -- narrow it at the call site.
   *
   * The targets run in the current run with `sourceNodeId`'s run-time outputs
   * answering from `options.run` (its `exposeOutput`'s `run`), or from `event`
   * when no `run` is given. A node that routes execution and has run-time
   * outputs of its own passes what they carry there, and hands its targets the
   * event it was given.
   */
  dispatch(
    sourceNodeId: string,
    sourceHandleId: string,
    event: unknown,
    options?: ExecDispatchOptions,
  ): Promise<{ primary: unknown; results: unknown[] }>
  /** What a call from the graph of `callerNodeId` may target, for a picker. The caller itself is left out. */
  callTargets(callerNodeId: string): Promise<GraphCallTargets>
  /**
   * The actions `target` offers to a call from the graph of `callerNodeId`.
   * Refused, by throwing, when the target does not resolve or is in another
   * space.
   */
  callableActions(callerNodeId: string, target: GraphCallTarget): Promise<GraphCallAction[]>
  /**
   * Calls `actionId` of `target` from the graph of `callerNodeId`, and answers
   * its result once the work has ended (`async` actions included); for several
   * nodes, their results in order. A call from a graph runs as nobody: a node
   * action gets no `callerAgent`, an App action runs as its extension's system
   * identity. Several nodes are called one after another with the same
   * `params`, and the first failure stops the rest. Refused before anything
   * runs when the target is not in the caller's space or does not resolve, and
   * when the action is declared `admin`; refused as a loop when the call would
   * re-enter an action still running in the same chain, or when the chain is
   * already 32 actions deep. A failure throws with the problem the target
   * recorded (`problem`: title, detail, next step).
   */
  call(
    callerNodeId: string,
    target: GraphCallTarget,
    actionId: string,
    params: Record<string, unknown>,
  ): Promise<unknown>
}

export declare const terminal: HostTerminalApi
/**
 * The reason a context's source gave for refusing it to agents (`TerminalContext.agentRefusal`),
 * or null when it gave none. The host's remote tools refuse such a context with this reason. An App
 * action that resolves a terminal its caller named should do the same for every caller but a
 * person using the App's own UI (`callerPerson`): an agent's `app_call` from a surface that cannot
 * name the agent sets neither `callerAgent` nor `callerPerson`.
 */
export declare const agentRefusalOf: typeof AgentRefusalOf
export declare const ssh: HostSshApi
export declare const execContext: HostExecContextApi
