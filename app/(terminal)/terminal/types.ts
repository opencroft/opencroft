export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
}

export interface LocalConfig {
  shell?: string;
  args?: string[];
}

export interface WslConfig {
  distro?: string;
  command?: string;
  args?: string[];
}

export interface ConnectPayload extends SshConnectionConfig {
  cols: number;
  rows: number;
}

export interface LocalPayload {
  shell?: string;
  args?: string[];
  cols: number;
  rows: number;
}

export type TerminalConfig =
  | { type: 'ssh'; config: SshConnectionConfig }
  | { type: 'local'; config: LocalConfig }
  | { type: 'wsl'; config: WslConfig };

export interface WslPayload {
  distro?: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
}

export type ClientMessage =
  | { type: 'connect'; payload: ConnectPayload }
  | { type: 'local'; payload: LocalPayload }
  | { type: 'wsl'; payload: WslPayload }
  | { type: 'data'; payload: { data: string } }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'disconnect' };

export type ServerMessage =
  | { type: 'data'; payload: { data: string } }
  | { type: 'connected'; payload: { sessionId: string } }
  | { type: 'error'; payload: { message: string } }
  | { type: 'disconnected'; payload: { reason: string } };
