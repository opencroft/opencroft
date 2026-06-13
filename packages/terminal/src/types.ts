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
  [key: string]: unknown
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
}

export interface LocalPayload extends LocalConfig {
  cols: number
  rows: number
}

export interface WslPayload extends WslConfig {
  cols: number
  rows: number
}

export type ClientMessage =
  | { type: 'connect'; payload: ConnectPayload }
  | { type: 'local'; payload: LocalPayload }
  | { type: 'wsl'; payload: WslPayload }
  | { type: 'data'; payload: { data: string } }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'disconnect' }

export type ServerMessage =
  | { type: 'data'; payload: { data: string } }
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'disconnected'; payload: { reason: string } }
