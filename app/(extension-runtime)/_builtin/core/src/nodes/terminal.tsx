import {
  React,
  InputHandle,
  icons,
  useNodeContext,
} from '@ext/host';
import { WindowShell } from '../shared';

const { useEffect, useRef, useState } = React;

interface WindowData {
  title: string;
  connection?: TerminalConnection;
}

interface TerminalConnection {
  type: 'ssh' | 'local' | 'wsl';
  config: Record<string, unknown>;
}

interface XtermLikeTerminal {
  open(el: HTMLElement): void;
  write(data: string): void;
  dispose(): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: (size: { cols: number; rows: number }) => void): void;
  loadAddon(addon: unknown): void;
  cols: number;
  rows: number;
  getSelection(): string;
  clearSelection(): void;
}

interface FitAddonLike { fit(): void; }

const TERMINAL_THEME = {
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
};

function buildConnectMessage(
  connection: TerminalConnection,
  cols: number,
  rows: number,
): Record<string, unknown> {
  if (connection.type === 'ssh') {
    return { type: 'connect', payload: { ...connection.config, cols, rows } };
  }
  if (connection.type === 'wsl') {
    return { type: 'wsl', payload: { ...connection.config, cols, rows } };
  }
  return { type: 'local', payload: { ...connection.config, cols, rows } };
}

function connectionFromContext(value: Record<string, unknown> | undefined): TerminalConnection | null {
  if (!value) {
    return null;
  }
  const { type, ...config } = value;
  return { type: (type as TerminalConnection['type']) ?? 'local', config };
}

type TerminalStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

function TerminalBody({
  connection,
  onStatusChange,
}: {
  connection: TerminalConnection;
  onStatusChange?: (status: TerminalStatus) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermLikeTerminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = useState(0);
  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;

  useEffect(() => {
    statusCallbackRef.current?.(status);
  }, [status]);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  const reconnect = () => {
    setStatus('connecting');
    setErrorMsg(null);
    setReconnectTick((n) => n + 1);
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return undefined;
    }
    let disposed = false;
    let fit: FitAddonLike | null = null;
    let observer: ResizeObserver | null = null;
    let contextMenuHandler: ((e: MouseEvent) => void) | null = null;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xtermMod, fitMod]) => {
      if (disposed || !el.isConnected) {
        return;
      }
      const term = new xtermMod.Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorInactiveStyle: 'none',
        fontSize: 13,
        fontFamily: 'Consolas, Menlo, Monaco, Courier New, monospace',
        scrollback: 10000,
        allowProposedApi: true,
        rightClickSelectsWord: false,
        theme: TERMINAL_THEME,
      }) as unknown as XtermLikeTerminal;
      termRef.current = term;

      fit = new fitMod.FitAddon() as unknown as FitAddonLike;
      term.loadAddon(fit);
      term.open(el);
      fit.fit();

      contextMenuHandler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).then(() => term.clearSelection());
        } else {
          navigator.clipboard.readText().then((text) => {
            if (text && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: 'data', payload: { data: text } }));
            }
          });
        }
      };
      el.addEventListener('contextmenu', contextMenuHandler);

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.hostname}:3334`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify(buildConnectMessage(connectionRef.current, term.cols, term.rows)));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'data') {
            term.write(msg.payload.data);
            return;
          }
          if (msg.type === 'connected') {
            setStatus('connected');
            return;
          }
          if (msg.type === 'error') {
            setStatus('error');
            setErrorMsg(msg.payload.message);
            term.write(`\r\n\x1b[31m[Error: ${msg.payload.message}]\x1b[0m\r\n`);
            return;
          }
          if (msg.type === 'disconnected') {
            setStatus('disconnected');
            term.write(`\r\n\x1b[31m[Disconnected: ${msg.payload.reason}]\x1b[0m\r\n`);
            return;
          }
        } catch {
          // ignore bad payloads
        }
      };
      ws.onerror = () => {
        setStatus('error');
        setErrorMsg('WebSocket connection failed');
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', payload: { data } }));
        }
      });
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', payload: { cols, rows } }));
        }
      });

      observer = new ResizeObserver(() => {
        try {
          fit?.fit();
        } catch {
          // ignore
        }
      });
      observer.observe(el);
    }).catch((err) => {
      setStatus('error');
      setErrorMsg(`xterm load failed: ${String(err)}`);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      if (contextMenuHandler) {
        el.removeEventListener('contextmenu', contextMenuHandler);
      }
      try {
        wsRef.current?.send(JSON.stringify({ type: 'disconnect' }));
      } catch {
        // ignore
      }
      wsRef.current?.close();
      wsRef.current = null;
      try {
        termRef.current?.dispose();
      } catch {
        // ignore
      }
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectTick]);

  return (
    <div className='relative flex flex-col h-full'>
      <div ref={containerRef} className='flex-1 min-h-0 bg-black rounded-sm overflow-hidden' />
      {status !== 'connected' ? (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <div className='flex flex-col items-center gap-2 px-3 py-2 rounded-md bg-black/70 text-xs text-muted-foreground pointer-events-auto nodrag nopan'>
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
  );
}

export function TerminalWindowNode({
  id, data, selected,
}: { id: string; data: WindowData; selected?: boolean }) {
  const ctx = useNodeContext<Record<string, unknown>>(id, 'ssh-in');
  const connection: TerminalConnection | null = data.connection ?? connectionFromContext(ctx?.value);
  const [status, setStatus] = useState<TerminalStatus>('connecting');

  return (
    <WindowShell
      id={id}
      selected={selected}
      loading={connection !== null && status !== 'connected'}
      icon={icons.TerminalSquare}
      iconClassName='text-green-400'
      title={data.title || 'Terminal'}
      bodyClassName='bg-black'
      input={(
        <InputHandle type='terminal-context' id='ssh-in' />
      )}
    >
      {connection ? (
        <TerminalBody connection={connection} onStatusChange={setStatus} />
      ) : (
        <div className='p-3 text-[11px] text-muted-foreground italic'>
          Connect an SSH / WSL / Localhost node&apos;s terminal output to this window.
        </div>
      )}
    </WindowShell>
  );
}

export function TerminalWindowInspector({ data }: { nodeId: string; data: WindowData; updateData: (p: Partial<WindowData>) => void }) {
  return (
    <div className='flex flex-col gap-2 text-xs'>
      <div className='font-medium'>{data.title || 'Terminal'}</div>
      {data.connection ? (
        <pre className='text-[10px] font-mono bg-muted rounded-sm p-2 overflow-x-auto'>
          {JSON.stringify(data.connection, null, 2)}
        </pre>
      ) : (
        <div className='text-muted-foreground italic'>No connection configured.</div>
      )}
    </div>
  );
}
