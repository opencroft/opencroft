'use client';

import { type Node, type NodeProps } from '@xyflow/react';
import { AppWindow, Circle, Play, Plus, Square, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { type NodeSettingsProps, type NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/app-dashboard/registry';
import {
  type AppData,
  type AppService,
  composeDown,
  composeUp,
  getContainerStatuses,
  loadApp,
  saveApp,
} from '@/app/(legacy-app-dashboard)/nodes/application/actions';
import { NodeCard, NodeCardContent, NodeCardHeader } from '@/app/(legacy-app-dashboard)/nodes/shared/node-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';

export type ApplicationNodeData = {
  appName: string;
  serviceNames: string[];
};

export type ApplicationNode = Node<ApplicationNodeData, 'application'>;

function ApplicationComponent({ id, data, selected }: NodeProps<ApplicationNode>) {
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    getContainerStatuses({ data: id }).then(setStatuses);
  }, [id]);

  const names = data.serviceNames ?? [];

  return (
    <NodeCard selected={selected} accent="oklch(0.7 0.2 260)">
      <NodeCardHeader
        icon={AppWindow}
        iconClassName="text-blue-400"
        title={data.appName || 'Application'}
        extra={<span className="text-[10px] text-muted-foreground tabular-nums">{names.length}</span>}
      />
      {names.length > 0 && (
        <NodeCardContent>
          <div className="flex flex-col gap-0.5">
            {names.map((name) => {
              const st = statuses[name];
              return (
                <div key={name} className="flex items-center gap-1.5 text-[10px]">
                  <Circle className={`h-2 w-2 ${st === 'running' ? 'fill-green-500 text-green-500' : 'fill-muted-foreground/30 text-muted-foreground/30'}`} />
                  <span className="font-mono text-muted-foreground">{name}</span>
                </div>
              );
            })}
          </div>
        </NodeCardContent>
      )}
    </NodeCard>
  );
}

function emptyService(): AppService {
  return { name: '', image: '', ports: [], env: [], volumes: [], restart: 'unless-stopped', command: '' };
}

function ServiceEditor({ service, onChange, onRemove }: {
  service: AppService;
  onChange: (s: AppService) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded border p-2">
      <div className="flex items-center gap-1">
        <Input value={service.name} onChange={(e) => onChange({ ...service, name: e.target.value })} placeholder="service name" className="h-7 text-xs font-mono flex-1" />
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
      <Input value={service.image} onChange={(e) => onChange({ ...service, image: e.target.value })} placeholder="image" className="h-7 text-xs font-mono" />

      <Label className="text-[10px] text-muted-foreground">Ports</Label>
      {service.ports.map((p, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input value={p.host} onChange={(e) => {
            const next = [...service.ports]; next[i] = { ...next[i], host: e.target.value }; onChange({ ...service, ports: next });
          }} placeholder="host" className="h-6 text-[10px] font-mono flex-1" />
          <span className="text-[10px]">:</span>
          <Input value={p.container} onChange={(e) => {
            const next = [...service.ports]; next[i] = { ...next[i], container: e.target.value }; onChange({ ...service, ports: next });
          }} placeholder="container" className="h-6 text-[10px] font-mono flex-1" />
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {
            const next = [...service.ports]; next.splice(i, 1); onChange({ ...service, ports: next });
          }}>
            <Trash2 className="h-2.5 w-2.5" />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => onChange({ ...service, ports: [...service.ports, { host: '', container: '' }] })}>
        <Plus className="h-2.5 w-2.5 mr-0.5" /> Port
      </Button>

      <Label className="text-[10px] text-muted-foreground">Environment</Label>
      {service.env.map((e, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input value={e.key} onChange={(ev) => {
            const next = [...service.env]; next[i] = { ...next[i], key: ev.target.value }; onChange({ ...service, env: next });
          }} placeholder="KEY" className="h-6 text-[10px] font-mono flex-1" />
          <Input value={e.value} onChange={(ev) => {
            const next = [...service.env]; next[i] = { ...next[i], value: ev.target.value }; onChange({ ...service, env: next });
          }} placeholder="value" className="h-6 text-[10px] font-mono flex-1" />
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {
            const next = [...service.env]; next.splice(i, 1); onChange({ ...service, env: next });
          }}>
            <Trash2 className="h-2.5 w-2.5" />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => onChange({ ...service, env: [...service.env, { key: '', value: '' }] })}>
        <Plus className="h-2.5 w-2.5 mr-0.5" /> Env
      </Button>

      <Label className="text-[10px] text-muted-foreground">Volumes</Label>
      {service.volumes.map((v, i) => (
        <div key={i} className="flex items-center gap-1">
          <Input value={v.host} onChange={(e) => {
            const next = [...service.volumes]; next[i] = { ...next[i], host: e.target.value }; onChange({ ...service, volumes: next });
          }} placeholder="host path" className="h-6 text-[10px] font-mono flex-1" />
          <span className="text-[10px]">:</span>
          <Input value={v.container} onChange={(e) => {
            const next = [...service.volumes]; next[i] = { ...next[i], container: e.target.value }; onChange({ ...service, volumes: next });
          }} placeholder="container path" className="h-6 text-[10px] font-mono flex-1" />
          <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => {
            const next = [...service.volumes]; next.splice(i, 1); onChange({ ...service, volumes: next });
          }}>
            <Trash2 className="h-2.5 w-2.5" />
          </Button>
        </div>
      ))}
      <Button variant="ghost" size="sm" className="h-5 text-[10px]" onClick={() => onChange({ ...service, volumes: [...service.volumes, { host: '', container: '' }] })}>
        <Plus className="h-2.5 w-2.5 mr-0.5" /> Volume
      </Button>
    </div>
  );
}

function ApplicationSettings({ id, updateData, onDirtyChange, onLoadingChange }: NodeSettingsProps<ApplicationNodeData>) {
  const [appData, setAppData] = useState<AppData>({ name: '', services: [], context: 'default' });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    onLoadingChange(true);
    loadApp({ data: id }).then((data) => {
      if (data) {
        setAppData(data);
      }
      onLoadingChange(false);
    });
  }, [id]);

  const markDirty = useCallback(() => setDirty(true), []);

  const updateApp = useCallback((patch: Partial<AppData>) => {
    setAppData((prev) => ({ ...prev, ...patch }));
    markDirty();
  }, [markDirty]);

  const updateService = useCallback((index: number, service: AppService) => {
    setAppData((prev) => {
      const services = [...prev.services];
      services[index] = service;
      return { ...prev, services };
    });
    markDirty();
  }, [markDirty]);

  const removeService = useCallback((index: number) => {
    setAppData((prev) => ({
      ...prev,
      services: prev.services.filter((_, i) => i !== index),
    }));
    markDirty();
  }, [markDirty]);

  useEffect(() => {
    onDirtyChange(dirty, async () => {
      await saveApp({ data: { appId: id, data: appData } });
      updateData({
        appName: appData.name,
        serviceNames: appData.services.map((s) => s.name).filter(Boolean),
      });
      setDirty(false);
      toast.success('App saved');
    });
  }, [dirty, appData, id, updateData, onDirtyChange]);

  const handleUp = useCallback(async () => {
    await saveApp({ data: { appId: id, data: appData } });
    await composeUp({ data: id });
    toast.success('Containers started');
  }, [id, appData]);

  const handleDown = useCallback(async () => {
    await composeDown({ data: id });
    toast.success('Containers stopped');
  }, [id]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label className="text-xs">App Name</Label>
        <Input value={appData.name} onChange={(e) => updateApp({ name: e.target.value })} className="h-7 text-xs" />
      </div>

      <div className="flex gap-1">
        <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={handleUp}>
          <Play className="h-3 w-3 mr-1" /> Up
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs flex-1" onClick={handleDown}>
          <Square className="h-3 w-3 mr-1" /> Down
        </Button>
      </div>

      <Separator />

      <Label className="text-xs">Services</Label>
      {appData.services.map((s, i) => (
        <ServiceEditor
          key={i}
          service={s}
          onChange={(updated) => updateService(i, updated)}
          onRemove={() => removeService(i)}
        />
      ))}
      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => updateApp({ services: [...appData.services, emptyService()] })}>
        <Plus className="h-3 w-3 mr-1" /> Add Service
      </Button>
    </div>
  );
}

export const applicationDefinition: NodeTypeDefinition<ApplicationNodeData> = {
  type: 'application',
  label: 'Application',
  icon: AppWindow,
  group: 'Infrastructure',
  defaultData: () => ({ appName: '', serviceNames: [] }),
  component: ApplicationComponent,
  settings: ApplicationSettings,
};
