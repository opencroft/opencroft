import {
  React,
  NodeFrame,
  OutputHandle,
  icons,
  inspectorIntent,
  invoke,
  useReactFlow,
} from '@ext/host';
import {
  Input,
  Label,
} from '@ext/ui';
import { PinButton, StatsList, PinnedBody, InspectorTerminalBody, InspectorFilesBody } from '../shared';

const { useCallback, useEffect, useState } = React;

interface WslStats { os: string; cpu: string; memory: string; storage: string; }
export interface WslData { distro: string; }

export function WslNode({
  id, data, selected,
}: { id: string; data: WslData; selected?: boolean }) {
  const [stats, setStats] = useState<WslStats | null>(null);
  const rf = useReactFlow();

  useEffect(() => {
    if (!data.distro) {
      setStats(null);
      return;
    }
    invoke<WslStats>('wsl.getStats', data.distro).then(setStats).catch(() => setStats(null));
  }, [data.distro]);

  const openInspector = useCallback((tab: string) => {
    rf.setNodes((nds) => nds.map((n: { id: string }) => ({ ...n, selected: n.id === id })));
    inspectorIntent.open(id, tab);
  }, [id, rf]);

  const openTerminal = useCallback(() => openInspector('terminal'), [openInspector]);
  const openFiles = useCallback(() => openInspector('files'), [openInspector]);

  return (
    <NodeFrame
      icon={icons.SquareTerminal}
      title={data.distro || 'WSL'}
      subtitle={stats?.os}
      status={stats ? 'success' : data.distro ? 'neutral' : 'warning'}
      selected={selected ?? false}
    >
      <PinnedBody
        input={
          stats ? (
            <StatsList
              items={[
                { icon: icons.Cpu, value: stats.cpu },
                { icon: icons.MemoryStick, value: stats.memory },
                { icon: icons.HardDrive, value: stats.storage },
              ]}
            />
          ) : (
            <div className='text-[10px] text-muted-foreground italic'>
              {data.distro ? 'loading stats…' : 'set distro in inspector'}
            </div>
          )
        }
        output={
          <>
            <OutputHandle type='terminal-context' id='ssh-out'>
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

export function WslInspector({
  data, updateData,
}: { nodeId: string; data: WslData; updateData: (p: Partial<WslData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Distro</Label>
        <Input
          value={data.distro ?? ''}
          onChange={(e) => updateData({ distro: e.target.value })}
          placeholder='Ubuntu'
        />
      </div>
    </div>
  );
}

export function WslTerminalTab({
  data,
}: { nodeId: string; data: WslData; updateData: (p: Partial<WslData>) => void }) {
  if (!data.distro) {
    return (
      <div className='p-3 text-xs text-muted-foreground italic'>
        Set a distro name to use the terminal.
      </div>
    );
  }
  return (
    <InspectorTerminalBody connection={{ type: 'wsl', config: { distro: data.distro } }} />
  );
}

export function WslFilesTab({
  data,
}: { nodeId: string; data: WslData; updateData: (p: Partial<WslData>) => void }) {
  if (!data.distro) {
    return (
      <div className='p-3 text-xs text-muted-foreground italic'>
        Set a distro name to browse files.
      </div>
    );
  }
  return (
    <InspectorFilesBody
      connection={{
        id: `wsl:${data.distro}`,
        name: data.distro,
        type: 'wsl',
        config: { distro: data.distro, basePath: '/' },
      }}
    />
  );
}
