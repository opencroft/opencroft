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
   * Internal: raw bytes to write to the spawned process's stdin, then close it. Set by a
   * `TerminalBackend` implementation to deliver `env` out-of-band (see `buildEnvInjection` in
   * exec-util) when it can't pass a real env map to the transport -- not a caller-facing stdin
   * passthrough.
   */
  stdin?: Buffer
}

/** The result of a `TerminalBackend.exec`/`run` call — identical shape across every backend. */
export interface ExecResult {
  stdout: string
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
}

/** SSH credentials for interactive shells and SFTP. */
export interface SshCredentials {
  host: string
  port?: number
  username: string
  password?: string
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

export interface ConnectPayload extends SshConnectionConfig {
  cols: number
  rows: number
  cwd?: string
  /**
   * Opaque client-supplied key (e.g. a terminal node id) identifying this logical session across
   * reconnects. At most one live session exists per sessionKey — see AttachPayload. Omit for the
   * legacy behavior: the session dies when the socket closes.
   */
  sessionKey?: string
}

export interface LocalPayload extends LocalConfig {
  cols: number
  rows: number
  cwd?: string
  sessionKey?: string
}

export interface WslPayload extends WslConfig {
  cols: number
  rows: number
  cwd?: string
  sessionKey?: string
}

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

export type ServerMessage =
  | { type: 'data'; payload: { data: string } }
  | { type: 'connected'; payload: { sessionId: string; reattached?: boolean } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'disconnected'; payload: { reason: string } }
  /** Sent in reply to `attach` when the sessionId/sessionKey is unknown or expired. */
  | { type: 'session-gone'; payload: { message: string } }
