'use client'

import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal as Xterm } from '@xterm/xterm'
import * as React from 'react'

import type { TerminalConfig } from '../types'
import { openingMessage, sessionGoneMessage, type TerminalSource, tabScopedSource } from './session-messages'
import { browserTabId } from './tab-identity'
import { terminalTheme } from './theme'

export type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 8000

interface ConnectSourceProps {
  /** What to connect to: an SSH host, a local shell, or a WSL distro. */
  connection: TerminalConfig
  /** Command to run instead of an interactive shell (e.g. `docker logs -f …`). */
  command?: string
  /**
   * Opaque key identifying this logical session across reconnects (e.g. a terminal node id).
   * Each browser tab runs its own shell under the key. When set, the server keeps that shell
   * alive across a socket drop (page reload, closed tab, network blip) until its idle timeout,
   * and this component auto-reconnects and re-attaches instead of spawning a fresh shell.
   * Unmounting the component while the page stays ends the shell.
   * Omit to keep the legacy behavior: the shell dies with the socket.
   */
  sessionKey?: string
  /**
   * With `sessionKey`: one shell for everyone who opens the key, in any tab and of any user. Every
   * viewer sees it live and can type, a newcomer joins it, and unmounting only stops watching. Key
   * it by the id of the node it belongs to: the server ends it when that node leaves its graph.
   */
  shared?: boolean
  /**
   * Bump this (e.g. `Date.now()`) to force-kill the current session and spawn a brand new one —
   * for a "restart session" affordance. No-op on the initial render. With `shared`, each value
   * restarts the shell once, however many viewers deliver it and however late.
   */
  restartToken?: string | number
  attachKey?: never
}

interface AttachSourceProps {
  /**
   * Watch the session this key names — output started by server code — and nothing else.
   *
   * The component never opens a session in this mode: every socket, the first and each one after
   * a drop, only asks to attach. When the session no longer exists it stops and calls
   * `onSessionGone`; there is no reconnect button, since reconnecting could only find the same
   * nothing. To watch something new, mount again with the new key.
   */
  attachKey: string
  connection?: never
  command?: never
  sessionKey?: never
  shared?: never
  restartToken?: never
}

interface TerminalCommonProps {
  /** Render output only — keystrokes and clipboard pastes are not sent. */
  readOnly?: boolean
  fontSize?: number
  /**
   * This terminal is displaying the output of something, not offering a shell to type into.
   *
   * A process that ends is then the ordinary end of the story rather than a fault: there is
   * nothing wrong and nothing to reconnect to, so no disconnect notice, no reconnect button and
   * no red end-of-stream line appear. Without this the same code path reports a completed run as
   * a lost connection, which reads as broken.
   *
   * A failure to start is still shown — that is a different event from a stream ending, and one
   * the reader can act on.
   */
  logView?: boolean
  onStatusChange?: (status: TerminalStatus) => void
  /**
   * With `attachKey`: the session no longer exists on the server — it ended and was reclaimed,
   * or the key never named one. Status is then `disconnected`; this says why.
   */
  onSessionGone?: (message: string) => void
}

export type TerminalProps = TerminalCommonProps & (ConnectSourceProps | AttachSourceProps)

function createWebSocket(path: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${protocol}//${window.location.host}${path}`)
}

function sourceOf(props: TerminalProps): TerminalSource {
  if (props.attachKey !== undefined) {
    return { kind: 'attach', sessionKey: props.attachKey }
  }
  const { connection, command, sessionKey, shared } = props
  return { kind: 'connect', connection, command, sessionKey, shared }
}

/** Embeddable xterm terminal. Connects over the `/api/ws/terminal` WebSocket. */
export function Terminal(props: TerminalProps) {
  const { command, readOnly, fontSize = 12, restartToken, logView, onStatusChange, onSessionGone, attachKey } = props
  const attachOnly = attachKey !== undefined
  const containerRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Xterm | null>(null)
  const wsRef = React.useRef<WebSocket | null>(null)
  const [status, setStatus] = React.useState<TerminalStatus>('connecting')
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null)
  const [reconnectTick, setReconnectTick] = React.useState(0)
  const statusRef = React.useRef(status)
  statusRef.current = status
  const sourceRef = React.useRef<TerminalSource>(sourceOf(props))
  sourceRef.current = sourceOf(props)
  const readOnlyRef = React.useRef(readOnly)
  readOnlyRef.current = readOnly
  const logViewRef = React.useRef(logView)
  logViewRef.current = logView
  const statusCallbackRef = React.useRef(onStatusChange)
  statusCallbackRef.current = onStatusChange
  const sessionGoneCallbackRef = React.useRef(onSessionGone)
  sessionGoneCallbackRef.current = onSessionGone

  React.useEffect(() => {
    statusCallbackRef.current?.(status)
  }, [status])

  const reconnect = React.useCallback(() => {
    setStatus('connecting')
    setErrorMsg(null)
    setReconnectTick((n) => n + 1)
  }, [])

  // "Restart session": kill the live session outright (regardless of sessionKey) and spawn a
  // fresh one. A plain `reconnect()` alone would just re-attach to the same (possibly hung)
  // session when a sessionKey is set, so this explicitly disconnects first. No-op on mount.
  //
  // A shared shell is the server's to restart, and the token goes with the request: every viewer
  // delivers the same press, and the server applies it once. Its viewers, this one included, are
  // then told to rejoin. The server only takes it from a socket watching the shell, so it waits
  // for one. A tab whose shell has ended has nothing to restart, and just opens the key again.
  const prevRestartTokenRef = React.useRef(restartToken)
  const pendingRestartRef = React.useRef<string | null>(null)
  const flushRestartRef = React.useRef<(() => void) | null>(null)
  React.useEffect(() => {
    if (restartToken === undefined || prevRestartTokenRef.current === restartToken) {
      prevRestartTokenRef.current = restartToken
      return
    }
    prevRestartTokenRef.current = restartToken
    const source = sourceRef.current
    if (source.kind === 'connect' && source.shared) {
      if (statusRef.current === 'disconnected' || statusRef.current === 'error') {
        reconnect()
        return
      }
      pendingRestartRef.current = String(restartToken)
      flushRestartRef.current?.()
      return
    }
    try {
      wsRef.current?.send(JSON.stringify({ type: 'disconnect' }))
    } catch {
      /* ignore */
    }
    reconnect()
  }, [restartToken, reconnect])

  // Unmounting while the page stays is the user closing the terminal, and its shell ends with it.
  // A reload or a closed tab unmounts nothing: the socket just drops, and the server keeps the
  // shell for the tab to come back to. A layout cleanup runs before the cleanup of the socket
  // effect below, so the socket is still there to say it on. A shared shell is not this viewer's
  // to end: leaving only stops watching it.
  React.useLayoutEffect(
    () => () => {
      const source = sourceRef.current
      if (source.kind === 'connect' && source.shared) {
        return
      }
      try {
        wsRef.current?.send(JSON.stringify({ type: 'disconnect' }))
      } catch {
        /* not open yet: nothing was started to end */
      }
    },
    [],
  )

  // Terminal lifecycle is intentionally keyed on reconnectTick + command + attachKey + fontSize only.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return undefined
    }
    let disposed = false
    let terminated = false
    let fit: FitAddon | null = null
    let observer: ResizeObserver | null = null
    let contextMenuHandler: ((e: MouseEvent) => void) | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    // Once we've ever gotten `connected`, an unexpected close should try to re-attach before
    // falling back to spawning fresh — set on the first successful connect of this mount.
    let sessionId: string | null = null
    let attemptingReattach = false
    // Whether the current socket has been told `connected` and nothing has ended it since: the only
    // state in which the server takes a restart from it.
    let watching = false

    const clearReconnectTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const tabSource = () => tabScopedSource(sourceRef.current, browserTabId())

    const flushRestart = () => {
      const token = pendingRestartRef.current
      const ws = wsRef.current
      if (token === null || !watching || ws?.readyState !== WebSocket.OPEN) {
        return
      }
      pendingRestartRef.current = null
      ws.send(JSON.stringify({ type: 'restart', payload: { token } }))
    }
    flushRestartRef.current = flushRestart

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

        const scheduleReconnect = () => {
          if (disposed || terminated) {
            return
          }
          setStatus('connecting')
          const delayMs = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS)
          reconnectAttempt += 1
          clearReconnectTimer()
          reconnectTimer = setTimeout(() => {
            if (!disposed) {
              openSocket()
            }
          }, delayMs)
        }

        const openSocket = () => {
          const ws = createWebSocket('/api/ws/terminal')
          wsRef.current = ws
          watching = false

          ws.onopen = () => {
            reconnectAttempt = 0
            ws.send(
              JSON.stringify(openingMessage(tabSource(), { attemptingReattach, sessionId }, term.cols, term.rows)),
            )
          }
          ws.onmessage = (e) => {
            try {
              const msg = JSON.parse(e.data)
              if (msg.type === 'data') {
                term.write(msg.payload.data)
                return
              }
              if (msg.type === 'connected') {
                sessionId = msg.payload.sessionId
                attemptingReattach = true
                terminated = false
                watching = true
                setStatus('connected')
                flushRestart()
                return
              }
              if (msg.type === 'session-gone') {
                // Our stored identity is stale server-side. A connect source falls back to a fresh
                // connect on the same socket rather than another reconnect round trip; an attach
                // source has nothing to fall back to, and stops.
                sessionId = null
                attemptingReattach = false
                const next = sessionGoneMessage(tabSource(), term.cols, term.rows)
                if (!next) {
                  terminated = true
                  setStatus('disconnected')
                  sessionGoneCallbackRef.current?.(msg.payload.message)
                  return
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(next))
                }
                return
              }
              if (msg.type === 'error') {
                setStatus('error')
                setErrorMsg(msg.payload.message)
                term.write(`\r\n\x1b[31m[Error: ${msg.payload.message}]\x1b[0m\r\n`)
                return
              }
              if (msg.type === 'disconnected') {
                sessionId = null
                attemptingReattach = false
                watching = false
                // The shared shell was restarted, by any of its viewers: join the one that replaces it.
                if (msg.payload.rejoin) {
                  term.write(`\r\n\x1b[33m[${msg.payload.reason}]\x1b[0m\r\n`)
                  ws.send(
                    JSON.stringify(
                      openingMessage(tabSource(), { attemptingReattach, sessionId }, term.cols, term.rows),
                    ),
                  )
                  return
                }
                // The shell process/channel itself ended — not just the socket. Don't auto-retry;
                // that would silently spawn a brand new shell after e.g. the user typed `exit`.
                terminated = true
                setStatus('disconnected')
                // A log view has reached the end of what it was showing. That is the expected
                // end, so it is not announced as a fault — the output stays on screen as it is.
                if (!logViewRef.current) {
                  term.write(`\r\n\x1b[31m[Disconnected: ${msg.payload.reason}]\x1b[0m\r\n`)
                }
                return
              }
            } catch {
              /* ignore */
            }
          }
          ws.onerror = () => {
            /* onclose follows and drives reconnect/backoff; nothing extra to do here */
          }
          ws.onclose = () => {
            watching = false
            if (disposed || terminated) {
              return
            }
            scheduleReconnect()
          }

          term.onData(sendInput)
          term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', payload: { cols, rows } }))
            }
          })
        }

        openSocket()

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
      flushRestartRef.current = null
      clearReconnectTimer()
      observer?.disconnect()
      if (contextMenuHandler) {
        el.removeEventListener('contextmenu', contextMenuHandler)
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
  }, [reconnectTick, command, attachKey, fontSize])

  return (
    <div className='relative flex flex-col h-full w-full bg-black p-2'>
      <div ref={containerRef} className='flex-1 min-h-0' />
      {status !== 'connected' && !(logView && status === 'disconnected') ? (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <div className='flex flex-col items-center gap-2 px-3 py-2 rounded-md bg-black/70 text-xs text-muted-foreground pointer-events-auto'>
            <span>
              {status === 'connecting' ? 'connecting…' : status === 'error' ? `error: ${errorMsg}` : 'disconnected'}
            </span>
            {status !== 'connecting' && !attachOnly ? (
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
