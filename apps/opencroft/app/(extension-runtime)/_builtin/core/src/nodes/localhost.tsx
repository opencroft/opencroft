import {
  React,
  NodeFrame,
  OutputHandle,
  icons,
  inspectorIntent,
  invoke,
  useReactFlow,
} from '@ext/host';
import { PinButton, StatsList, PinnedBody, InspectorFilesBody } from '../shared';
import { Terminal } from '@ext/ui';

const { useCallback, useEffect, useState } = React;

interface LocalhostStats {
  os: string; cpu: string; memory: string; storage: string; hostname: string; platform: string;
}

export function LocalhostNode({
  id, data, selected,
}: { id: string; data: Record<string, unknown>; selected?: boolean }) {
  void data;
  const [stats, setStats] = useState<LocalhostStats | null>(null);
  const rf = useReactFlow();

  useEffect(() => {
    invoke<LocalhostStats>('localhost.getStats').then(setStats).catch(() => null);
  }, []);

  const openInspector = useCallback((tab: string) => {
    rf.setNodes((nds) => nds.map((n: { id: string }) => ({ ...n, selected: n.id === id })));
    inspectorIntent.open(id, tab);
  }, [id, rf]);

  const openTerminal = useCallback(() => openInspector('terminal'), [openInspector]);
  const openFiles = useCallback(() => openInspector('files'), [openInspector]);

  return (
    <NodeFrame
      icon={icons.Monitor}
      title={stats?.hostname || 'Localhost'}
      subtitle={stats?.platform}
      status={stats ? 'success' : 'neutral'}
      selected={selected ?? false}
    >
      <PinnedBody
        input={
          stats ? (
            <StatsList
              items={[
                { icon: icons.Monitor, value: stats.os },
                { icon: icons.Cpu, value: stats.cpu },
                { icon: icons.MemoryStick, value: stats.memory },
                { icon: icons.HardDrive, value: stats.storage },
              ]}
            />
          ) : (
            <div className='text-[10px] text-muted-foreground italic'>loading stats…</div>
          )
        }
        output={
          <>
            <OutputHandle type='terminal-context' id='terminal'>
              <PinButton icon={icons.TerminalSquare} label='Terminal' onClick={openTerminal} />
            </OutputHandle>
            <OutputHandle type='filesystem-target' id='fs-out'>
              <PinButton icon={icons.FolderOpen} label='Files' onClick={openFiles} />
            </OutputHandle>
          </>
        }
      />
    </NodeFrame>
  );
}

export function LocalhostInspector() {
  const [stats, setStats] = useState<LocalhostStats | null>(null);

  useEffect(() => {
    invoke<LocalhostStats>('localhost.getStats').then(setStats).catch(() => null);
  }, []);

  if (!stats) {
    return <div className='text-xs text-muted-foreground italic'>Loading…</div>;
  }

  const rows = [
    ['Hostname', stats.hostname],
    ['OS', stats.os],
    ['Platform', stats.platform],
    ['CPU', stats.cpu],
    ['Memory', stats.memory],
    ['Storage', stats.storage],
  ];

  return (
    <div className='flex flex-col gap-2'>
      {rows.map(([label, value]) => (
        <div key={label} className='flex justify-between text-xs'>
          <span className='text-muted-foreground'>{label}</span>
          <span className='font-mono'>{value}</span>
        </div>
      ))}
    </div>
  );
}

export function LocalhostTerminalTab() {
  return (
    <Terminal connection={{ type: 'local', config: {} }} />
  );
}

export function LocalhostFilesTab() {
  return (
    <InspectorFilesBody
      connection={{
        id: 'localhost',
        name: 'Localhost',
        type: 'ssh',
        config: { host: 'localhost', port: 22, username: 'root', basePath: '/' },
      }}
    />
  );
}
