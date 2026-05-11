import os from 'os';

import * as pty from '@lydell/node-pty';
import { WebSocket, WebSocketServer } from 'ws';

import * as sshClient from '@/app/(ssh)/server/ssh-client';
import { SshCredentials, SshShell } from '@/app/(ssh)/server/ssh-client';

interface ConnectPayload extends SshCredentials {
  command?: string;
  cols: number;
  rows: number;
}

interface LocalPayload {
  shell?: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
}

interface WslPayload {
  distro?: string;
  command?: string;
  args?: string[];
  cols: number;
  rows: number;
}

type Session =
  | { type: 'ssh'; shell: SshShell }
  | { type: 'pty'; proc: pty.IPty };

type ClientMessage =
  | { type: 'connect'; payload: ConnectPayload }
  | { type: 'local'; payload: LocalPayload }
  | { type: 'wsl'; payload: WslPayload }
  | { type: 'data'; payload: { data: string } }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'disconnect' };

const sessions = new Map<WebSocket, Session>();

function send(ws: WebSocket, type: string, payload: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function destroySession(ws: WebSocket) {
  const session = sessions.get(ws);
  if (!session) {
    return;
  }
  if (session.type === 'ssh') {
    session.shell.close();
  } else {
    session.proc.kill();
  }
  sessions.delete(ws);
}

async function handleConnect(ws: WebSocket, payload: ConnectPayload) {
  const { cols, rows, command, ...creds } = payload;

  try {
    const sh = await sshClient.shell(creds, cols, rows, command);

    sessions.set(ws, { type: 'ssh', shell: sh });

    sh.onData((data) => send(ws, 'data', { data }));
    sh.onClose(() => {
      send(ws, 'disconnected', { reason: 'Shell closed' });
      sessions.delete(ws);
    });

    send(ws, 'connected', { sessionId: 'ssh' });
  } catch (err) {
    send(ws, 'error', { message: `SSH ${creds.host}: ${(err as Error).message}` });
  }
}

function resolveShell(file: string): string {
  if (os.platform() !== 'win32') {
    return file;
  }
  if (file.includes('.') || file.includes('/') || file.includes('\\')) {
    return file;
  }
  return file + '.exe';
}

function spawnPty(ws: WebSocket, file: string, args: string[], cols: number, rows: number, label: string) {
  const resolved = resolveShell(file);
  try {
    const proc = pty.spawn(resolved, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });

    sessions.set(ws, { type: 'pty', proc });

    proc.onData((data) => send(ws, 'data', { data }));
    proc.onExit(() => {
      send(ws, 'disconnected', { reason: 'Shell exited' });
      sessions.delete(ws);
    });

    send(ws, 'connected', { sessionId: label });
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[${label}] spawn failed:`, msg);
    send(ws, 'error', { message: `Failed to spawn "${resolved}" ${args.join(' ')}: ${msg}` });
  }
}

function handleLocal(ws: WebSocket, payload: LocalPayload) {
  const defaultShell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
  const exe = payload.command || payload.shell || defaultShell;
  spawnPty(ws, exe, payload.args || [], payload.cols, payload.rows, 'local');
}

function handleWsl(ws: WebSocket, payload: WslPayload) {
  const args: string[] = [];
  if (payload.distro) {
    args.push('-d', payload.distro);
  }
  if (payload.command) {
    args.push('--exec', payload.command, ...(payload.args || []));
  }
  spawnPty(ws, 'wsl.exe', args, payload.cols, payload.rows, 'wsl');
}

function handleMessage(ws: WebSocket, raw: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  switch (msg.type) {
    case 'connect':
      handleConnect(ws, msg.payload);
      break;
    case 'local':
      handleLocal(ws, msg.payload);
      break;
    case 'wsl':
      handleWsl(ws, msg.payload);
      break;
    case 'data': {
      const session = sessions.get(ws);
      if (!session) {
        break;
      }
      if (session.type === 'ssh') {
        session.shell.write(msg.payload.data);
      } else {
        session.proc.write(msg.payload.data);
      }
      break;
    }
    case 'resize': {
      const session = sessions.get(ws);
      if (!session) {
        break;
      }
      if (session.type === 'ssh') {
        session.shell.resize(msg.payload.cols, msg.payload.rows);
      } else {
        session.proc.resize(msg.payload.cols, msg.payload.rows);
      }
      break;
    }
    case 'disconnect':
      destroySession(ws);
      break;
  }
}

export function setupTerminalWss(wss: WebSocketServer) {
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      handleMessage(ws, raw.toString());
    });
    ws.on('close', () => destroySession(ws));
  });
}
