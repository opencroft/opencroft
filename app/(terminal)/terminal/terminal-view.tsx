'use client';

import { useCallback, useEffect, useRef } from 'react';

import { terminalTheme } from '@/app/(terminal)/terminal/theme';
import { TerminalConfig } from '@/app/(terminal)/terminal/types';
import { useTerminalWs } from '@/app/(terminal)/terminal/use-terminal-ws';

interface TerminalViewProps {
  termConfig: TerminalConfig;
  onConnected: (sessionId: string) => void;
  onDisconnected: (reason: string) => void;
  onError: (message: string) => void;
}

export function TerminalView({ termConfig, onConnected, onDisconnected, onError }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  const termConfigRef = useRef(termConfig);

  const handleData = useCallback((data: string) => {
    termRef.current?.write(data);
  }, []);

  const handleConnected = useCallback((sessionId: string) => {
    onConnected(sessionId);
  }, [onConnected]);

  const handleDisconnected = useCallback((reason: string) => {
    termRef.current?.write(`\r\n\x1b[31m[Disconnected: ${reason}]\x1b[0m\r\n`);
    onDisconnected(reason);
  }, [onDisconnected]);

  const handleError = useCallback((message: string) => {
    termRef.current?.write(`\r\n\x1b[31m[Error: ${message}]\x1b[0m\r\n`);
    onError(message);
  }, [onError]);

  const ws = useTerminalWs({
    onData: handleData,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    onError: handleError,
  });

  // Keep refs to latest hook methods so the effect closure always calls current versions
  const wsRef = useRef(ws);
  wsRef.current = ws;

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any;
    let fit: { fit: () => void };
    let observer: ResizeObserver;
    const el = containerRef.current;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xtermMod, fitMod]) => {
      if (disposed || !el.isConnected) {
        return;
      }

      term = new xtermMod.Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorInactiveStyle: 'none',
        fontSize: 16,
        fontFamily: 'Consolas, Menlo, Monaco, Courier New, monospace',
        scrollback: 10000,
        allowProposedApi: true,
        rightClickSelectsWord: false,
        theme: terminalTheme,
      });

      fit = new fitMod.FitAddon();
      term.loadAddon(fit);
      // @ts-expect-error -- CSS module has no type declarations
      import('@xterm/xterm/css/xterm.css');
      term.open(el);

      el.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).then(() => term.clearSelection());
        } else {
          navigator.clipboard.readText().then(text => {
            if (text) {
              wsRef.current.write(text);
            }
          });
        }
      });

      import('@xterm/addon-webgl').then(({ WebglAddon }) => {
        try {
          if (!disposed) {
            term.loadAddon(new WebglAddon());
          }
        } catch {
          // Fallback to canvas
        }
      });

      fit.fit();
      termRef.current = term;

      term.onData((data: string) => {
        wsRef.current.write(data);
      });

      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        wsRef.current.resize(cols, rows);
      });

      wsRef.current.connect({ termConfig: termConfigRef.current, cols: term.cols, rows: term.rows });

      observer = new ResizeObserver(() => {
        fit.fit();
      });
      observer.observe(el);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      wsRef.current.disconnect();
      try {
        termRef.current?.dispose();
      } catch {
        // Already disposed
      }
      termRef.current = null;
    };

  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
