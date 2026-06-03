import type { Peer } from 'crossws'
import { defineWebSocketHandler } from 'nitro/h3'
import os from 'os'

import * as pty from '@lydell/node-pty'
import type { SshCredentials, SshShell } from '@/app/(ssh)/_server/ssh-client'
import * as sshClient from '@/app/(ssh)/_server/ssh-client'

interface ConnectPayload extends SshCredentials {
  command?: string
  cols: number
  rows: number
}

interface LocalPayload {
  shell?: string
  command?: string
  args?: string[]
  cols: number
  rows: number
}

interface WslPayload {
  distro?: string
  command?: string
  args?: string[]
  cols: number
  rows: number
}

type Session = { type: 'ssh'; shell: SshShell } | { type: 'pty'; proc: pty.IPty }

type ClientMessage =
  | { type: 'connect'; payload: ConnectPayload }
  | { type: 'local'; payload: LocalPayload }
  | { type: 'wsl'; payload: WslPayload }
  | { type: 'data'; payload: { data: string } }
  | { type: 'resize'; payload: { cols: number; rows: number } }
  | { type: 'disconnect' }

const sessions = new Map<Peer, Session>()

function send(peer: Peer, type: string, payload: Record<string, unknown>) {
  peer.send(JSON.stringify({ type, payload }))
}

function destroySession(peer: Peer) {
  const session = sessions.get(peer)
  if (!session) {
    return
  }
  if (session.type === 'ssh') {
    session.shell.close()
  } else {
    session.proc.kill()
  }
  sessions.delete(peer)
}

async function handleConnect(peer: Peer, payload: ConnectPayload) {
  const { cols, rows, command, ...creds } = payload

  try {
    const sh = await sshClient.shell(creds, cols, rows, command)

    sessions.set(peer, { type: 'ssh', shell: sh })

    sh.onData((data) => send(peer, 'data', { data }))
    sh.onClose(() => {
      send(peer, 'disconnected', { reason: 'Shell closed' })
      sessions.delete(peer)
    })

    send(peer, 'connected', { sessionId: 'ssh' })
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
  return file + '.exe'
}

function spawnPty(peer: Peer, file: string, args: string[], cols: number, rows: number, label: string) {
  const resolved = resolveShell(file)
  try {
    const proc = pty.spawn(resolved, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    })

    sessions.set(peer, { type: 'pty', proc })

    proc.onData((data) => send(peer, 'data', { data }))
    proc.onExit(() => {
      send(peer, 'disconnected', { reason: 'Shell exited' })
      sessions.delete(peer)
    })

    send(peer, 'connected', { sessionId: label })
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[${label}] spawn failed:`, msg)
    send(peer, 'error', { message: `Failed to spawn "${resolved}" ${args.join(' ')}: ${msg}` })
  }
}

function handleLocal(peer: Peer, payload: LocalPayload) {
  const defaultShell = os.platform() === 'win32' ? 'powershell.exe' : 'bash'
  const exe = payload.command || payload.shell || defaultShell
  spawnPty(peer, exe, payload.args || [], payload.cols, payload.rows, 'local')
}

function handleWsl(peer: Peer, payload: WslPayload) {
  const args: string[] = []
  if (payload.distro) {
    args.push('-d', payload.distro)
  }
  if (payload.command) {
    args.push('--exec', payload.command, ...(payload.args || []))
  }
  spawnPty(peer, 'wsl.exe', args, payload.cols, payload.rows, 'wsl')
}

function handleMessage(peer: Peer, raw: string) {
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
    case 'data': {
      const session = sessions.get(peer)
      if (!session) {
        break
      }
      if (session.type === 'ssh') {
        session.shell.write(msg.payload.data)
      } else {
        session.proc.write(msg.payload.data)
      }
      break
    }
    case 'resize': {
      const session = sessions.get(peer)
      if (!session) {
        break
      }
      if (session.type === 'ssh') {
        session.shell.resize(msg.payload.cols, msg.payload.rows)
      } else {
        session.proc.resize(msg.payload.cols, msg.payload.rows)
      }
      break
    }
    case 'disconnect':
      destroySession(peer)
      break
  }
}

// Terminal WebSocket, served at /api/ws/terminal by Nitro's file-based routing.
// Bridges browser xterm sessions to a local pty (powershell/bash/wsl) or an SSH
// shell. Each peer owns one session for the lifetime of the connection.
export default defineWebSocketHandler({
  message(peer, message) {
    handleMessage(peer, message.text())
  },
  close(peer) {
    destroySession(peer)
  },
})
