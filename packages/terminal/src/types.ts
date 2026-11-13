/** A terminal execution context (local, WSL, SSH, or docker-exec). */
export interface TerminalContext {
  type: string
  distro?: string
  host?: string
  port?: number
  username?: string
  password?: string
  keyPath?: string
  via?: TerminalContext
  contextName?: string
  containerId?: string
  cwd?: string
  /** docker-exec only: run as this user inside the container (`docker exec -u <user>`). */
  user?: string
  /** docker-exec only: preferred interactive shell (e.g. `/bin/zsh`) for shell sessions. */
  shell?: string
  /**
   * Set by the context's source when agents must not use it, as the reason they are refused with
   * (`agentRefusalOf`). A person's surfaces and the nodes wired to it use it like any other context.
   *
   * It is a top-level field, so it reaches whoever resolves a node that re-exposes the context
   * whole or spreads it (a Terminal Router route, a Git worktree's `{ ...base, cwd }`). A node
   * that wraps the context instead, nesting it as another context's `via`, drops it: the outer
   * context carries no refusal unless that node sets one of its own.
   */
  agentRefusal?: string
  [key: string]: unknown
}

/** Options shared by every `TerminalBackend.exec`/`run` call. */
export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>
  /** Kill the process/channel once this elapses. Default 120000ms. */
  timeoutMs?: number
  /** Stop accumulating output past this many bytes, per stream. Default 5MB. */
  maxOutputBytes?: number
  /**
   * Bytes written to the command's stdin, which is then closed. The channel for a value that must
   * not appear in any process's argv or environment (a private key, a password): stdin is not
   * readable through `/proc/<pid>/cmdline` or `/proc/<pid>/environ`. Every transport reaches the
   * command's own stdin, `docker-exec` through its parent's `docker exec -i`.
   *
   * Refused together with `env` wherever env itself is delivered over stdin (wsl, ssh,
   * docker-exec, local on Windows; see `buildEnvInjection` in exec-util): the two would share one
   * channel.
   */
  stdin?: Buffer
  /**
   * Keep stdout as bytes, in `ExecResult.stdoutBytes`, for a command whose output is a binary
   * file. `stdout` is then empty: decoding a binary as UTF-8 would replace every invalid
   * sequence. The output cap still applies.
   */
  binaryStdout?: boolean
}

/** The result of a `TerminalBackend.exec`/`run` call — identical shape across every backend. */
export interface ExecResult {
  stdout: string
  /** stdout as bytes, set only when the call asked for `binaryStdout`. */
  stdoutBytes?: Buffer
  stderr: string
  exitCode: number
  /** Either stream hit the output cap and was cut. Kept as the broad "something was lost" answer. */
  truncated?: boolean
  /**
   * `stdout` specifically was cut at the output cap. Separate from `truncated` because most
   * callers keep only stdout, and telling them their output is incomplete when it was really
   * stderr that overflowed is a false alarm about the one thing they can see.
   */
  stdoutTruncated?: boolean
  timedOut?: boolean
}

/** SSH connection parameters for one-shot command execution. */
export interface ServerConfig {
  address: string
  port: number
  username: string
  keyPath?: string
  password?: string
  /** As `SshCredentials.credentialsScope`. */
  credentialsScope?: string
}

/** SSH credentials for interactive shells and SFTP. */
export interface SshCredentials {
  host: string
  port?: number
  username: string
  password?: string
  /**
   * Where the credentials belong. Handed with the password to the host's
   * password resolver (`registerPasswordResolver`), where a password standing
   * for a secret resolves, and with a Key Store key reference to the host's
   * check (`registerKeyStoreAccess`), which says whether that store's keys may
   * be used here. Opaque to this package; the host passes the id of the node
   * the credentials are stored on.
   */
  credentialsScope?: string
  keyPath?: string
}

export interface SshConnectionConfig extends SshCredentials {
  /** Command to run instead of an interactive shell. */
  command?: string
}

export interface LocalConfig {
  shell?: string
  command?: string
  args?: string[]
}

export interface WslConfig {
  distro?: string
  command?: string
  args?: string[]
}

/** What a Terminal session connects to: an SSH host, a local shell, or a WSL distro. */
export type TerminalConfig =
  | { type: 'ssh'; config: SshConnectionConfig }
  | { type: 'local'; config: LocalConfig }
  | { type: 'wsl'; config: WslConfig }

/** What every message that opens a session carries beside its transport's config. */
export interface OpeningFields {
  cols: number
  rows: number
  cwd?: string
  /**
   * Opaque client-supplied key (e.g. a terminal node id) identifying this logical session across
   * reconnects. At most one live session exists per sessionKey — see AttachPayload. Omit for the
   * legacy behavior: the session dies when the socket closes.
   */
  sessionKey?: string
  /**
   * With a sessionKey: everyone who opens the key shares one shell, all watching and typing, and
   * nobody leaving ends it. Without it, a newcomer takes the shell over from whoever held it.
   */
  shared?: boolean
}

export interface ConnectPayload extends SshConnectionConfig, OpeningFields {}

export interface LocalPayload extends LocalConfig, OpeningFields {}

export interface WslPayload extends WslConfig, OpeningFields {}

export interface AttachPayload {
  /** Prefer sessionId when known (survives across the same client's reconnects). */
  sessionId?: string
  /** Falls back to sessionKey lookup when sessionId is absent/unknown to the server. */
  sessionKey?: string
  cols: number
  rows: number
}

export type ClientMessage =
  | { type: 'connect'; payload: ConnectPayload }
  | { type: 'local'; payload: LocalPayload }
  | { type: 'wsl'; payload: WslPayload }
  | { type: 'attach'; payload: AttachPayload }
  | { type: 'data'; payload: { data: string } }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'disconnect' }
  /**
   * Restart the shared shell this socket watches. Every viewer may deliver the same press, and at
   * any time after it, so the server applies a token once and ignores it from then on.
   */
  | { type: 'restart'; payload: { token: string } }

export type ServerMessage =
  | { type: 'data'; payload: { data: string } }
  | { type: 'connected'; payload: { sessionId: string; reattached?: boolean } }
  | { type: 'error'; payload: { message: string } }
  /** `rejoin`: the shared shell was restarted, and its viewers open the key again to join the next. */
  | { type: 'disconnected'; payload: { reason: string; rejoin?: boolean } }
  /** Sent in reply to `attach` when the sessionId/sessionKey is unknown or expired. */
  | { type: 'session-gone'; payload: { message: string } }
