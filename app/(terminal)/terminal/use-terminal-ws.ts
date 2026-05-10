'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ClientMessage, TerminalConfig, ServerMessage } from '@/app/(terminal)/terminal/types';
import { createWebSocket } from '@/hooks/utils/use-websocket';

interface UseTerminalWsOptions {
  onData: (data: string) => void;
  onConnected: (sessionId: string) => void;
  onDisconnected: (reason: string) => void;
  onError: (message: string) => void;
}

interface StartParams {
  termConfig: TerminalConfig;
  cols: number;
  rows: number;
}

export function useTerminalWs({ onData, onConnected, onDisconnected, onError }: UseTerminalWsOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle');
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<StartParams | null>(null);

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const sendMsg = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const createWs = useCallback(async (params: StartParams) => {
    cleanup();
    setStatus('connecting');

    const ws = createWebSocket('/api/ws/terminal');
    wsRef.current = ws;

    ws.onopen = () => {
      const { termConfig, cols, rows } = params;
      if (termConfig.type === 'ssh') {
        sendMsg({ type: 'connect', payload: { ...termConfig.config, cols, rows } });
      } else if (termConfig.type === 'wsl') {
        sendMsg({ type: 'wsl', payload: { distro: termConfig.config.distro, command: termConfig.config.command, args: termConfig.config.args, cols, rows } });
      } else {
        sendMsg({ type: 'local', payload: { shell: termConfig.config.shell, args: termConfig.config.args, cols, rows } });
      }
    };

    ws.onmessage = (e) => {
      const msg: ServerMessage = JSON.parse(e.data);
      switch (msg.type) {
        case 'data': {
          onData(msg.payload.data);
          break;
        }
        case 'connected': {
          setStatus('connected');
          onConnected(msg.payload.sessionId);
          break;
        }
        case 'error': {
          setStatus('disconnected');
          onError(msg.payload.message);
          break;
        }
        case 'disconnected': {
          setStatus('disconnected');
          onDisconnected(msg.payload.reason);
          break;
        }
      }
    };

    ws.onclose = () => {
      if (startRef.current) {
        reconnectTimer.current = setTimeout(() => {
          if (startRef.current) {
            createWs(startRef.current);
          }
        }, 2000);
      }
    };
  }, [cleanup, sendMsg, onData, onConnected, onDisconnected, onError]);

  const connect = useCallback((params: StartParams) => {
    startRef.current = params;
    createWs(params);
  }, [createWs]);

  const write = useCallback((data: string) => {
    sendMsg({ type: 'data', payload: { data } });
  }, [sendMsg]);

  const resize = useCallback((cols: number, rows: number) => {
    sendMsg({ type: 'resize', payload: { cols, rows } });
  }, [sendMsg]);

  const disconnect = useCallback(() => {
    startRef.current = null;
    sendMsg({ type: 'disconnect' });
    cleanup();
    setStatus('disconnected');
  }, [sendMsg, cleanup]);

  useEffect(() => {
    return cleanup;
  }, [cleanup]);

  return { status, connect, write, resize, disconnect };
}
