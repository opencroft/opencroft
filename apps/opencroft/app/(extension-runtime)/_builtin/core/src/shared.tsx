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
  { id: 'terminal', contextType: 'terminal-context', role: 'source', label: 'Terminal' },
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

export const AGENT_HANDLES: HandleDef[] = [
  { id: 'agent-in', contextType: 'agent-job', role: 'target', label: 'Jobs' },
  { id: 'instructions-in', contextType: 'agent-instruction', role: 'target', label: 'Instructions' },
];

export const AGENT_INSTRUCTION_HANDLES: HandleDef[] = [
  { id: 'instruction-out', contextType: 'agent-instruction', role: 'source', label: 'Agent' },
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
      <OutputHandle type='terminal-context' id='terminal'>
        <PinButton icon={icons.TerminalSquare} label='Terminal' onClick={onTerminal} />
      </OutputHandle>
      <OutputHandle type='filesystem-target' id='fs-out'>
        <PinButton icon={icons.FolderOpen} label='Files' onClick={onFiles} />
      </OutputHandle>
    </>
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
