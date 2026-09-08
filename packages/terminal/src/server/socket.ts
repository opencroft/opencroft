import os from 'node:os'

import * as pty from '@lydell/node-pty'

import type { AttachPayload, ClientMessage, ConnectPayload, LocalPayload, WslPayload } from '../types'
import { shellQuote } from './exec-util'
import { sessionManager } from './manager'
import type { SessionHandle, SocketPeer } from './session-manager'
import { type SshShell, shell as sshShell } from './ssh'

export type { SocketPeer } from './session-manager'

// The local pty must NOT inherit the full host process.env — in deployments that can carry
// DATABASE_URL and other secrets. Only pass through what a shell needs to behave normally, plus a
// forced sane terminal so xterm.js escape-sequence handling matches what the client expects.
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TZ']

function localPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      env[key] = value
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LC_') && value !== undefined) {
      env[key] = value
    }
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}

function send(peer: SocketPeer, type: string, payload: Record<string, unknown>) {
  peer.send(JSON.stringify({ type, payload }))
}

// --- Adapters: normalize pty.IPty / SshShell into the manager's transport-agnostic SessionHandle ---

function ptyHandle(proc: pty.IPty): SessionHandle {
  let alive = true
  proc.onExit(() => {
    alive = false
  })
  return {
    onData(fn) {
      proc.onData(fn)
    },
    onExit(fn) {
      proc.onExit(() => fn())
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill() {
      proc.kill()
    },
    isAlive() {
      return alive
    },
  }
}

function sshHandle(sh: SshShell): SessionHandle {
  let alive = true
  sh.onClose(() => {
    alive = false
  })
  return {
    onData(fn) {
      sh.onData(fn)
    },
    onExit(fn) {
      sh.onClose(fn)
    },
    write(data) {
      sh.write(data)
    },
    resize(cols, rows) {
      sh.resize(cols, rows)
    },
    kill() {
      sh.close()
    },
    isAlive() {
      return alive
    },
  }
}

// The registry is shared with server-started jobs, so it lives in its own module — see
// manager.ts. This file must never start a session on behalf of a client message beyond the
// connect/local/wsl cases below; job-session.ts is deliberately not imported here, and a test
// enforces that.
const manager = sessionManager

/**
 * Reconcile the manager's bookkeeping when sending a just-created session's `connected` reply
 * fails — the peer's socket is evidently already gone (e.g. it closed mid-connect, before the
 * async spawn/dial resolved), and no `close` callback will ever arrive for it. Routes through the
 * same close-handling as a real socket close so the session is detached (persistent) or killed
 * (legacy), instead of staying "attached" to a peer that will never speak again.
 */
function sendConnectedOrReconcile(peer: SocketPeer, sessionId: string, reattached: boolean): void {
  try {
    send(peer, 'connected', { sessionId, reattached })
  } catch {
    manager.handleSocketClose(peer)
  }
}

/** Decide connect/local/wsl outcome before spawning. Returns false once the caller must stop. */
function beginSession(peer: SocketPeer, sessionKey: string | undefined, cols: number, rows: number): boolean {
  const decision = manager.prepareConnect(peer, sessionKey, cols, rows)
  if (decision.kind === 'reattached') {
    sendConnectedOrReconcile(peer, decision.session.id, true)
    return false
  }
  if (decision.kind === 'refused') {
    send(peer, 'error', { message: decision.message })
    return false
  }
  return true
}

async function handleConnect(peer: SocketPeer, payload: ConnectPayload) {
  const { cols, rows, command, cwd, sessionKey, ...creds } = payload
  if (!beginSession(peer, sessionKey, cols, rows)) {
    return
  }
  // Prefer the user's login shell, but if `$SHELL` is unset/missing on the remote (minimal
  // images, some containers), fall back to a portable `sh -l` rather than leaving the session dead.
  const defaultShell = 'exec "$SHELL" -l 2>/dev/null || exec sh -l'
  const effectiveCommand = cwd ? `cd ${shellQuote(cwd)} && ${command || defaultShell}` : command

  try {
    const sh = await sshShell(creds, cols, rows, effectiveCommand)
    const managed = manager.create(peer, sshHandle(sh), { sessionKey })
    sendConnectedOrReconcile(peer, managed.id, false)
  } catch (err) {
    send(peer, 'error', { message: `SSH ${creds.host}: ${(err as Error).message}` })
  }
}

function resolveShell(file: string): string {
  if (os.platform() !== 'win32') {
    return file
  }
  if (file.includes('.') || file.includes('/') || file.includes('\\')) {
    return file
  }
  return `${file}.exe`
}

function spawnPty(
  peer: SocketPeer,
  file: string,
  args: string[],
  cols: number,
  rows: number,
  label: string,
  cwd: string | undefined,
  sessionKey: string | undefined,
) {
  if (!beginSession(peer, sessionKey, cols, rows)) {
    return
  }

  const resolved = resolveShell(file)
  try {
    const proc = pty.spawn(resolved, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd ?? os.homedir(),
      env: localPtyEnv(),
    })

    const managed = manager.create(peer, ptyHandle(proc), { sessionKey })
    sendConnectedOrReconcile(peer, managed.id, false)
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[${label}] spawn failed:`, msg)
    send(peer, 'error', { message: `Failed to spawn "${resolved}" ${args.join(' ')}: ${msg}` })
  }
}

function handleLocal(peer: SocketPeer, payload: LocalPayload) {
  const defaultShell = os.platform() === 'win32' ? 'cmd.exe' : 'bash'
  const exe = payload.command || payload.shell || defaultShell
  spawnPty(peer, exe, payload.args || [], payload.cols, payload.rows, 'local', payload.cwd, payload.sessionKey)
}

function handleWsl(peer: SocketPeer, payload: WslPayload) {
  const args: string[] = []
  if (payload.distro) {
    args.push('-d', payload.distro)
  }
  if (payload.cwd) {
    args.push('--cd', payload.cwd)
  }
  if (payload.command) {
    args.push('--exec', payload.command, ...(payload.args || []))
  }
  spawnPty(peer, 'wsl.exe', args, payload.cols, payload.rows, 'wsl', undefined, payload.sessionKey)
}

function handleAttach(peer: SocketPeer, payload: AttachPayload) {
  const result = manager.attach(peer, payload)
  if (result.ok) {
    sendConnectedOrReconcile(peer, result.session.id, true)
    return
  }
  send(peer, 'session-gone', { message: 'Session not found or expired; start a new connection.' })
}

function handleMessage(peer: SocketPeer, raw: string) {
  let msg: ClientMessage
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }

  switch (msg.type) {
    case 'connect':
      handleConnect(peer, msg.payload)
      break
    case 'local':
      handleLocal(peer, msg.payload)
      break
    case 'wsl':
      handleWsl(peer, msg.payload)
      break
    case 'attach':
      handleAttach(peer, msg.payload)
      break
    case 'data':
      manager.write(peer, msg.payload.data)
      break
    case 'resize':
      manager.resize(peer, msg.payload.cols, msg.payload.rows)
      break
    case 'disconnect':
      manager.handleDisconnect(peer)
      break
  }
}

/**
 * WebSocket session handler bridging browser xterm clients to a local pty (powershell/bash/wsl)
 * or an SSH shell. Sessions are server-owned (see `SessionManager`): a socket close detaches a
 * keyed session (it keeps running and can be re-attached) but kills an unkeyed one, matching the
 * pre-existing behavior for clients that don't opt in to a sessionKey. Mount from a route's
 * websocket hooks.
 */
export const terminalSocket = {
  message(peer: SocketPeer, raw: string) {
    handleMessage(peer, raw)
  },
  close(peer: SocketPeer) {
    manager.handleSocketClose(peer)
  },
}
