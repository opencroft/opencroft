'use client'

import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import * as React from 'react'

function createWebSocket(path: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${protocol}//${window.location.host}${path}`)
}

interface InspectorTerminalBodyProps {
  connection: {
    type: 'ssh' | 'local' | 'wsl'
    config: Record<string, unknown>
  }
  /** Additional command to prepend (e.g. docker exec ... bash) */
  command?: string
}

/** Embeddable xterm terminal for inspector tabs. Connects over /api/ws/terminal. */
export function InspectorTerminalBody({ connection, command }: InspectorTerminalBodyProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const wsRef = React.useRef<WebSocket | null>(null)
  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting')
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null)
  const [reconnectTick, setReconnectTick] = React.useState(0)
  const connectionRef = React.useRef(connection)
  connectionRef.current = connection

  const reconnect = React.useCallback(() => {
    setStatus('connecting')
    setErrorMsg(null)
    setReconnectTick((n) => n + 1)
  }, [])

  function buildConnectMessage(conn: InspectorTerminalBodyProps['connection'], cols: number, rows: number) {
    const effectiveConfig = command ? { ...conn.config, command } : conn.config
    if (conn.type === 'ssh') {
      return { type: 'connect', payload: { ...effectiveConfig, cols, rows } }
    }
    if (conn.type === 'wsl') {
      return { type: 'wsl', payload: { ...effectiveConfig, cols, rows } }
    }
    return { type: 'local', payload: { ...effectiveConfig, cols, rows } }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: terminal lifecycle is intentionally keyed on reconnectTick + command only
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return undefined
    }
    let disposed = false
    let fit: FitAddon | null = null
    let observer: ResizeObserver | null = null
    let contextMenuHandler: ((e: MouseEvent) => void) | null = null

    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(([xtermMod, fitMod]) => {
        if (disposed || !el.isConnected) {
          return
        }
        const term = new xtermMod.Terminal({
          cursorBlink: true,
          cursorStyle: 'bar',
          cursorInactiveStyle: 'none',
          fontSize: 12,
          fontFamily: 'Consolas, Menlo, Monaco, Courier New, monospace',
          scrollback: 10000,
          allowProposedApi: true,
          rightClickSelectsWord: false,
          theme: {
            foreground: '#cccccc',
            background: '#000000',
            cursor: '#cccccc',
            black: '#0c0c0c',
            red: '#c50f1f',
            green: '#13a10e',
            yellow: '#c19c00',
            blue: '#0037da',
            magenta: '#881798',
            cyan: '#3a96dd',
            white: '#cccccc',
            brightBlack: '#767676',
            brightRed: '#e74856',
            brightGreen: '#16c60c',
            brightYellow: '#f9f1a5',
            brightBlue: '#3b78ff',
            brightMagenta: '#b4009e',
            brightCyan: '#61d6d6',
            brightWhite: '#f2f2f2',
          },
        })
        termRef.current = term

        fit = new fitMod.FitAddon()
        term.loadAddon(fit)
        term.open(el)
        fit.fit()

        contextMenuHandler = (e: MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          const selection = term.getSelection()
          if (selection) {
            navigator.clipboard.writeText(selection).then(() => term.clearSelection())
          } else {
            navigator.clipboard.readText().then((text) => {
              if (text && wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'data', payload: { data: text } }))
              }
            })
          }
        }
        el.addEventListener('contextmenu', contextMenuHandler)

        const ws = createWebSocket('/api/ws/terminal')
        wsRef.current = ws

        ws.onopen = () => {
          ws.send(JSON.stringify(buildConnectMessage(connectionRef.current, term.cols, term.rows)))
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

        term.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'data', payload: { data } }))
          }
        })
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
  }, [reconnectTick, command])

  return (
    <div className='relative flex flex-col h-full w-full bg-black p-2'>
      <div ref={containerRef} className='flex-1 min-h-0' />
      {status !== 'connected' ? (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <div className='flex flex-col items-center gap-2 px-3 py-2 rounded-md bg-black/70 text-xs text-muted-foreground pointer-events-auto'>
            <span>{status === 'connecting' ? 'connecting…' : status === 'error' ? `error: ${errorMsg}` : 'disconnected'}</span>
            {status !== 'connecting' ? (
              <button type='button' onClick={reconnect} className='px-2 py-0.5 rounded-sm bg-muted text-foreground hover:bg-muted/80'>
                reconnect
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
