import {
  React,
  NodeCard,
  NodeResizer,
  OutputHandle,
  useNodeAccent,
  useReactFlow,
  useUpdateNodeInternals,
  icons,
} from '@ext/host';
import {
  Button,
  FileBrowser,
  FileManagerProvider,
} from '@ext/ui';

const { useCallback, useEffect, useState } = React;

const OPEN_ANIMATION_MS = 250;
const CLOSE_ANIMATION_MS = 200;

// ═════════════════════════════════════════════════════════════════════
// Handle definitions
// ═════════════════════════════════════════════════════════════════════

export type HandleDef = { id: string; contextType: string; role: 'source' | 'target'; label?: string; dynamic?: boolean };

export const TERMINAL_SOURCE: HandleDef[] = [
  { id: 'ssh-out', contextType: 'terminal-context', role: 'source', label: 'Terminal' },
  { id: 'fs-out', contextType: 'filesystem-target', role: 'source', label: 'Files' },
];

export const TERMINAL_CONSUMER: HandleDef[] = [
  { id: 'ssh-in', contextType: 'terminal-context', role: 'target', label: 'Terminal' },
];

export const FS_TARGET_CONSUMER: HandleDef[] = [
  { id: 'fs-in', contextType: 'filesystem-target', role: 'target', label: 'FS' },
];

export const SCRIPT_CONSUMER: HandleDef[] = [
  { id: 'ctx-in', contextType: 'terminal-context', role: 'target', label: 'Target' },
  { id: 'stdout-out', contextType: 'text-stream', role: 'source', label: 'Output' },
];

export const SCRIPT_CONSUMER_PYTHON: HandleDef[] = [
  { id: 'ctx-in', contextType: 'terminal-context', role: 'target', label: 'Target' },
  { id: 'exec-in', contextType: 'execution-context', role: 'target', label: 'Handler' },
  { id: 'stdout-out', contextType: 'text-stream', role: 'source', label: 'Output' },
];

export const SCRIPT_CONSUMER_NODEJS: HandleDef[] = [
  { id: 'ctx-in', contextType: 'terminal-context', role: 'target', label: 'Target' },
  { id: 'exec-in', contextType: 'execution-context', role: 'target', label: 'Handler' },
  { id: 'stdout-out', contextType: 'text-stream', role: 'source', label: 'Output' },
];

export const DOCKER_HANDLES: HandleDef[] = [
  { id: 'ctx-in', contextType: 'terminal-context', role: 'target', label: 'Host' },
  { id: 'context-in', contextType: 'terminal-context', role: 'target', label: 'Context' },
  { id: 'docker-out', contextType: 'docker-context', role: 'source', label: 'Docker' },
];

export const APP_HANDLES: HandleDef[] = [
  { id: 'docker-in', contextType: 'docker-context', role: 'target', label: 'Docker' },
  { id: 'volumes-in', contextType: 'volume-mount', role: 'target', label: 'Volumes' },
  { id: 'inst-', contextType: 'terminal-context', role: 'source', label: 'Terminal', dynamic: true },
];

export const VOLUME_HANDLES: HandleDef[] = [
  { id: 'vol-out', contextType: 'volume-mount', role: 'source', label: 'Volume' },
];

export const GIT_WORKSPACE_HANDLES: HandleDef[] = [
  { id: 'ctx-in', contextType: 'terminal-context', role: 'target', label: 'Terminal' },
];

export const AGENT_HANDLES: HandleDef[] = [
  { id: 'agent-in', contextType: 'agent-job', role: 'target', label: 'Jobs' },
];

export const AGENT_JOB_HANDLES: HandleDef[] = [
  { id: 'job-out', contextType: 'agent-job', role: 'source', label: 'Agent' },
];

// ═════════════════════════════════════════════════════════════════════
// PinButton
// ═════════════════════════════════════════════════════════════════════

interface PinButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick?: () => void;
}

export function PinButton({ icon: Icon, label, onClick }: PinButtonProps) {
  return (
    <Button
      variant='ghost'
      size='sm'
      className='nodrag nopan h-5 text-[10px] px-1.5'
      onClick={onClick}
    >
      <Icon className='h-2.5 w-2.5 shrink-0' />
      <span className='truncate'>{label}</span>
    </Button>
  );
}

// ═════════════════════════════════════════════════════════════════════
// StatsList & PinnedBody
// ═════════════════════════════════════════════════════════════════════

export function StatsList({ items }: { items: { icon: React.ComponentType<{ className?: string }>; value: string }[] }) {
  return (
    <div className='flex flex-col gap-0.5'>
      {items.map((item) => (
        <div key={item.value} className='flex items-center gap-1.5 text-[10px]'>
          <item.icon className='h-2.5 w-2.5 text-muted-foreground shrink-0' />
          <span className='text-muted-foreground truncate'>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export function PinnedBody({
  input,
  output,
}: {
  input?: React.ReactNode;
  output?: React.ReactNode;
}) {
  return (
    <div className='flex justify-between gap-2'>
      {input ? <div className='flex-1 min-w-0'>{input}</div> : null}
      {output ? <div className='flex flex-col gap-0.5'>{output}</div> : null}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// Output pin helpers — shared by Localhost, WSL, Server
// ═════════════════════════════════════════════════════════════════════

export function TerminalFileOutputs({
  onTerminal,
  onFiles,
}: {
  onTerminal: () => void;
  onFiles: () => void;
}) {
  return (
    <>
      <OutputHandle type='terminal-context' id='ssh-out'>
        <PinButton icon={icons.TerminalSquare} label='Terminal' onClick={onTerminal} />
      </OutputHandle>
      <OutputHandle type='filesystem-target' id='fs-out'>
        <PinButton icon={icons.FolderOpen} label='Files' onClick={onFiles} />
      </OutputHandle>
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════
// InspectorTerminalBody — embeddable terminal for inspector tabs
// ═════════════════════════════════════════════════════════════════════

interface InspectorTerminalBodyProps {
  connection: {
    type: 'ssh' | 'local' | 'wsl';
    config: Record<string, unknown>;
  };
  /** Additional command to prepend (e.g. docker exec ... bash) */
  command?: string;
}

export function InspectorTerminalBody({ connection, command }: InspectorTerminalBodyProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const termRef = React.useRef<unknown>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const [status, setStatus] = React.useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [reconnectTick, setReconnectTick] = React.useState(0);
  const connectionRef = React.useRef(connection);
  connectionRef.current = connection;

  const reconnect = React.useCallback(() => {
    setStatus('connecting');
    setErrorMsg(null);
    setReconnectTick((n) => n + 1);
  }, []);

  function buildConnectMessage(conn: InspectorTerminalBodyProps['connection'], cols: number, rows: number) {
    const effectiveConfig = command
      ? { ...conn.config, command }
      : conn.config;
    if (conn.type === 'ssh') {
      return { type: 'connect', payload: { ...effectiveConfig, cols, rows } };
    }
    if (conn.type === 'wsl') {
      return { type: 'wsl', payload: { ...effectiveConfig, cols, rows } };
    }
    return { type: 'local', payload: { ...effectiveConfig, cols, rows } };
  }

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    let disposed = false;
    let fit: unknown = null;
    let observer: ResizeObserver | null = null;
    let contextMenuHandler: ((e: MouseEvent) => void) | null = null;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xtermMod, fitMod]) => {
      if (disposed || !el.isConnected) return;
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
          foreground: '#cccccc', background: '#000000', cursor: '#cccccc',
          black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
          blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
          brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c',
          brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e',
          brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
        },
      });
      termRef.current = term;

      fit = new fitMod.FitAddon();
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
          if (msg.type === 'data') { term.write(msg.payload.data); return; }
          if (msg.type === 'connected') { setStatus('connected'); return; }
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
        } catch { /* ignore */ }
      };
      ws.onerror = () => { setStatus('error'); setErrorMsg('WebSocket connection failed'); };

      term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'data', payload: { data } }));
        }
      });
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', payload: { cols, rows } }));
        }
      });

      observer = new ResizeObserver(() => { try { fit?.fit(); } catch { /* ignore */ } });
      observer.observe(el);
    }).catch((err) => { setStatus('error'); setErrorMsg(`xterm load failed: ${String(err)}`); });

    return () => {
      disposed = true;
      observer?.disconnect();
      if (contextMenuHandler) el.removeEventListener('contextmenu', contextMenuHandler);
      try { wsRef.current?.send(JSON.stringify({ type: 'disconnect' })); } catch { /* ignore */ }
      wsRef.current?.close(); wsRef.current = null;
      try { termRef.current?.dispose(); } catch { /* ignore */ }
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectTick, command]);

  return (
    <div className='relative flex flex-col h-full w-full bg-black p-2'>
      <div ref={containerRef} className='flex-1 min-h-0' />
      {status !== 'connected' ? (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <div className='flex flex-col items-center gap-2 px-3 py-2 rounded-md bg-black/70 text-xs text-muted-foreground pointer-events-auto'>
            <span>{status === 'connecting' ? 'connecting…' : status === 'error' ? `error: ${errorMsg}` : 'disconnected'}</span>
            {status !== 'connecting' ? (
              <button type='button' onClick={reconnect} className='px-2 py-0.5 rounded-sm bg-muted text-foreground hover:bg-muted/80'>reconnect</button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════
// InspectorFilesBody — embeddable file browser for inspector tabs
// ═════════════════════════════════════════════════════════════════════

interface StorageConnection {
  id: string;
  name: string;
  type: 's3' | 'ssh' | 'wsl' | 'docker';
  config: Record<string, unknown>;
}

export function InspectorFilesBody({ connection }: { connection: StorageConnection }) {
  return (
    <FileManagerProvider initialConnection={connection}>
      <FileBrowser />
    </FileManagerProvider>
  );
}

// ═════════════════════════════════════════════════════════════════════
// WindowShell — resizable NodeCard with title bar
// ═════════════════════════════════════════════════════════════════════

const WINDOW_GRID = 10;
const snap = (v: number) => Math.round(v / WINDOW_GRID) * WINDOW_GRID;

interface WindowShellProps {
  id: string;
  selected?: boolean;
  loading?: boolean;
  icon: React.ComponentType<{ className?: string }>;
  iconClassName?: string;
  title: string;
  bodyClassName?: string;
  input?: React.ReactNode;
  children: React.ReactNode;
  minWidth?: number;
  minHeight?: number;
}

export function WindowShell({
  id, selected, loading, icon: Icon, iconClassName, title,
  bodyClassName, input, children,
  minWidth = 300, minHeight = 200,
}: WindowShellProps) {
  const accent = useNodeAccent();
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => updateNodeInternals(id), OPEN_ANIMATION_MS);
    return () => clearTimeout(t);
  }, [id, updateNodeInternals]);

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
    }, CLOSE_ANIMATION_MS);
  }, [id, setNodes]);

  return (
    <>
      <NodeResizer
        isVisible
        minWidth={minWidth}
        minHeight={minHeight}
        onResizeEnd={(_event, { width, height }) => {
          setNodes((nds) => nds.map((n) => (
            n.id === id
              ? { ...n, style: { ...n.style, width: snap(width), height: snap(height) } }
              : n
          )));
        }}
        lineStyle={{ border: '8px solid transparent', zIndex: 1 }}
        handleStyle={{ background: 'transparent', border: 'none', width: 16, height: 16, zIndex: 1 }}
      />
      <div className={`h-full w-full ${closing ? 'window-node-close' : 'window-node-open'}`}>
        <NodeCard
          selected={selected}
          loading={loading}
          accent={accent}
          className='h-full w-full min-w-0 flex flex-col'
        >
          <div className='flex items-center gap-2 px-4 py-2'>
            {input}
            <Icon className={`h-4 w-4 shrink-0 ${iconClassName ?? ''}`} />
            <span className='text-sm font-medium truncate flex-1'>{title}</span>
            <Button
              variant='ghost'
              size='icon'
              className='nodrag nopan h-4 w-4 shrink-0'
              onClick={close}
            >
              <icons.X className='h-3 w-3' />
            </Button>
          </div>
          <div
            className={
              'flex-1 nodrag nopan nowheel overflow-hidden rounded-b-md mx-px mb-px relative '
              + (bodyClassName ?? 'bg-card')
            }
          >
            <div className='absolute inset-2'>
              {children}
            </div>
          </div>
        </NodeCard>
      </div>
    </>
  );
}
