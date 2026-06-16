'use client'

import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal as Xterm } from '@xterm/xterm'
import * as React from 'react'

import type { ClientMessage, TerminalConfig } from '../types'
import { terminalTheme } from './theme'

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface TerminalProps {
  /** What to connect to: an SSH host, a local shell, or a WSL distro. */
  connection: TerminalConfig
  /** Command to run instead of an interactive shell (e.g. `docker logs -f …`). */
  command?: string
  /** Render output only — keystrokes and clipboard pastes are not sent. */
  readOnly?: boolean
  fontSize?: number
  onStatusChange?: (status: TerminalStatus) => void
}

function createWebSocket(path: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${protocol}//${window.location.host}${path}`)
}

function connectMessage(
  connection: TerminalConfig,
  command: string | undefined,
  cols: number,
  rows: number,
): ClientMessage {
  const extra = command ? { command } : undefined
  if (connection.type === 'ssh') {
    return { type: 'connect', payload: { ...connection.config, ...extra, cols, rows } }
  }
  if (connection.type === 'wsl') {
    return { type: 'wsl', payload: { ...connection.config, ...extra, cols, rows } }
  }
  return { type: 'local', payload: { ...connection.config, ...extra, cols, rows } }
}

/** Embeddable xterm terminal. Connects over the `/api/ws/terminal` WebSocket. */
export function Terminal({ connection, command, readOnly, fontSize = 12, onStatusChange }: TerminalProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Xterm | null>(null)
  const wsRef = React.useRef<WebSocket | null>(null)
  const [status, setStatus] = React.useState<TerminalStatus>('connecting')
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null)
  const [reconnectTick, setReconnectTick] = React.useState(0)
  const connectionRef = React.useRef(connection)
  connectionRef.current = connection
  const readOnlyRef = React.useRef(readOnly)
  readOnlyRef.current = readOnly
  const statusCallbackRef = React.useRef(onStatusChange)
  statusCallbackRef.current = onStatusChange

  React.useEffect(() => {
    statusCallbackRef.current?.(status)
  }, [status])

  const reconnect = React.useCallback(() => {
    setStatus('connecting')
    setErrorMsg(null)
    setReconnectTick((n) => n + 1)
  }, [])

  // Terminal lifecycle is intentionally keyed on reconnectTick + command + fontSize only.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return undefined
    }
    let disposed = false
    let fit: FitAddon | null = null
    let observer: ResizeObserver | null = null
    let contextMenuHandler: ((e: MouseEvent) => void) | null = null

    const sendInput = (data: string) => {
      if (readOnlyRef.current) {
        return
      }
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'data', payload: { data } }))
      }
    }

    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/xterm/css/xterm.css')])
      .then(([xtermMod, fitMod]) => {
        if (disposed || !el.isConnected) {
          return
        }
        const term = new xtermMod.Terminal({
          cursorBlink: true,
          cursorStyle: 'bar',
          cursorInactiveStyle: 'none',
          fontSize,
          fontFamily: 'Consolas, Menlo, Monaco, Courier New, monospace',
          scrollback: 10000,
          allowProposedApi: true,
          rightClickSelectsWord: false,
          theme: terminalTheme,
        })
        termRef.current = term

        fit = new fitMod.FitAddon()
        term.loadAddon(fit)
        term.open(el)
        fit.fit()

        import('@xterm/addon-webgl').then(({ WebglAddon }) => {
          try {
            if (!disposed) {
              term.loadAddon(new WebglAddon())
            }
          } catch {
            // Fallback to canvas
          }
        })

        contextMenuHandler = (e: MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          const selection = term.getSelection()
          if (selection) {
            navigator.clipboard.writeText(selection).then(() => term.clearSelection())
          } else {
            navigator.clipboard.readText().then((text) => {
              if (text) {
                sendInput(text)
              }
            })
          }
        }
        el.addEventListener('contextmenu', contextMenuHandler)

        const ws = createWebSocket('/api/ws/terminal')
        wsRef.current = ws

        ws.onopen = () => {
          ws.send(JSON.stringify(connectMessage(connectionRef.current, command, term.cols, term.rows)))
        }
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data)
            if (msg.type === 'data') {
              term.write(msg.payload.data)
              return
            }
            if (msg.type === 'connected') {
              setStatus('connected')
              return
            }
            if (msg.type === 'error') {
              setStatus('error')
              setErrorMsg(msg.payload.message)
              term.write(`\r\n\x1b[31m[Error: ${msg.payload.message}]\x1b[0m\r\n`)
              return
            }
            if (msg.type === 'disconnected') {
              setStatus('disconnected')
              term.write(`\r\n\x1b[31m[Disconnected: ${msg.payload.reason}]\x1b[0m\r\n`)
              return
            }
          } catch {
            /* ignore */
          }
        }
        ws.onerror = () => {
          setStatus('error')
          setErrorMsg('WebSocket connection failed')
        }

        term.onData(sendInput)
        term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', payload: { cols, rows } }))
          }
        })

        observer = new ResizeObserver(() => {
          try {
            fit?.fit()
          } catch {
            /* ignore */
          }
        })
        observer.observe(el)
      })
      .catch((err) => {
        setStatus('error')
        setErrorMsg(`xterm load failed: ${String(err)}`)
      })

    return () => {
      disposed = true
      observer?.disconnect()
      if (contextMenuHandler) {
        el.removeEventListener('contextmenu', contextMenuHandler)
      }
      try {
        wsRef.current?.send(JSON.stringify({ type: 'disconnect' }))
      } catch {
        /* ignore */
      }
      wsRef.current?.close()
      wsRef.current = null
      try {
        termRef.current?.dispose()
      } catch {
        /* ignore */
      }
      termRef.current = null
    }
  }, [reconnectTick, command, fontSize])

  return (
    <div className='relative flex flex-col h-full w-full bg-black p-2'>
      <div ref={containerRef} className='flex-1 min-h-0' />
      {status !== 'connected' ? (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <div className='flex flex-col items-center gap-2 px-3 py-2 rounded-md bg-black/70 text-xs text-muted-foreground pointer-events-auto'>
            <span>
              {status === 'connecting' ? 'connecting…' : status === 'error' ? `error: ${errorMsg}` : 'disconnected'}
            </span>
            {status !== 'connecting' ? (
              <button
                type='button'
                onClick={reconnect}
                className='px-2 py-0.5 rounded-sm bg-muted text-foreground hover:bg-muted/80'
              >
                reconnect
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
