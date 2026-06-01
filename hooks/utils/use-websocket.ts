'use client'

import { useCallback, useEffect, useRef } from 'react'

type Data = string | Blob | BufferSource

export function createWebSocket(path: string): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(`${protocol}//${window.location.host}${path}`)
}

export function useWebSocket(path: string, onMessage?: (data: Data) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage

  useEffect(() => {
    const ws = createWebSocket(path)
    wsRef.current = ws
    ws.onmessage = (e) => handlerRef.current?.(e.data)
    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [path])

  const send = useCallback((data: Data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }, [])

  return send
}
