import {
  React,
  NodeFrame,
  InputHandle,
  OutputHandle,
  dispatch,
  icons,
  inspectorIntent,
  toast,
  useDockerContainers,
  useDockerSnapshotReceived,
  useGraphEdges,
  useGraphNodes,
  useInspectorIntent,
  useNodeContext,
  useReactFlow,
} from '@ext/host';
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusIndicator,
  Textarea,
} from '@ext/ui';
import { COMPOSE_PROJECT } from '../../shared';
import { InspectorTerminalBody } from '../shared';

const { useCallback, useMemo, useState } = React;

export interface AppData {
  name: string;
  image: string;
  ports: string;
  env: string;
  command: string;
  entrypoint: string;
  ipc: string;
  shmSize: string;
  restart: string;
  replicas: number;
  containerName: string;
  workingDir: string;
  buildContext: string;
  buildDockerfile: string;
  gpu: boolean;
  requirementMemory: string;
  requirementCpu: string;
  init: boolean;
  readOnly: boolean;
  dependsOn: string;
  groupAdd: string;
  securityOpts: string;
  tmpfs: string;
  healthcheckTest: string;
  healthcheckInterval: string;
  healthcheckTimeout: string;
  healthcheckRetries: number;
  healthcheckStartPeriod: string;
  proxyDomain: string;
  proxyEntrypoint: string;
  proxyTls: boolean;
  proxyBasicAuth: string;
  proxyPort: number;
  exposeHostDocker: boolean;
  copyDockerBinaries: boolean;
  labels: string;
  secrets: string;
}

interface ContainerInfo {
  id: string;
  name: string;
  service: string;
  status: string;
  running: boolean;
}

interface DockerContext {
  type: string;
  [key: string]: unknown;
}

function instanceVariant(container: ContainerInfo): 'success' | 'warning' | 'destructive' {
  if (/^restarting/i.test(container.status)) {
    return 'warning';
  }
  if (!container.running) {
    return 'destructive';
  }
  if (/health:\s*starting/i.test(container.status)) {
    return 'warning';
  }
  if (/\(unhealthy\)/i.test(container.status)) {
    return 'destructive';
  }
  return 'success';
}

interface SecretsStoreNodeData {
  secretKeys?: string[];
}

function SecretsPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const nodes = useGraphNodes();

  const availableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const n of nodes as { type?: string; data?: SecretsStoreNodeData }[]) {
      if (n.type !== 'core-secrets-store') {
        continue;
      }
      for (const key of n.data?.secretKeys ?? []) {
        keys.add(key);
      }
    }
    return [...keys].sort();
  }, [nodes]);

  const selected = useMemo(
    () => value.split('\n').map((s) => s.trim()).filter(Boolean),
    [value],
  );

  const remaining = useMemo(
    () => availableKeys.filter((k) => !selected.includes(k)),
    [availableKeys, selected],
  );

  const remove = useCallback((name: string) => {
    onChange(selected.filter((s) => s !== name).join('\n'));
  }, [onChange, selected]);

  const add = useCallback((name: string) => {
    if (!name || selected.includes(name)) {
      return;
    }
    onChange([...selected, name].join('\n'));
  }, [onChange, selected]);

  const stale = selected.filter((s) => !availableKeys.includes(s));

  return (
    <div className='flex flex-col gap-1.5'>
      {selected.length > 0 ? (
        <div className='flex flex-wrap gap-1'>
          {selected.map((name) => {
            const missing = stale.includes(name);
            return (
              <Badge
                key={name}
                variant={missing ? 'destructive' : 'secondary'}
                className='gap-1 font-mono text-[10px] pr-1'
                title={missing ? 'Not found in any Secrets Store' : ''}
              >
                <span>{name}</span>
                <button
                  type='button'
                  onClick={() => remove(name)}
                  className='hover:opacity-70'
                >
                  <icons.X className='h-3 w-3' />
                </button>
              </Badge>
            );
          })}
        </div>
      ) : null}
      {remaining.length > 0 ? (
        <Select value='' onValueChange={(v: string) => add(v)}>
          <SelectTrigger className='h-7 text-xs'>
            <SelectValue placeholder='Add secret…' />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((k) => (
              <SelectItem key={k} value={k} className='font-mono text-xs'>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : availableKeys.length === 0 ? (
        <p className='text-[10px] text-muted-foreground italic'>
          No Secrets Stores in this graph. Add a Secrets Store node and define keys to pick from.
        </p>
      ) : (
        <p className='text-[10px] text-muted-foreground italic'>
          All available secrets ({availableKeys.length}) selected.
        </p>
      )}
    </div>
  );
}

function InstanceCard({
  index,
  container,
  onViewLogs,
  onViewShell,
}: {
  index: number;
  container: ContainerInfo;
  onViewLogs: () => void;
  onViewShell: () => void;
}) {
  return (
    <div className='flex items-center gap-1.5 text-[10px]'>
      <StatusIndicator variant={instanceVariant(container)} />
      <span className='text-muted-foreground'>#{index + 1}</span>
      <span className='flex-1 truncate'>{container.status}</span>
      <Button
        variant='ghost'
        size='sm'
        className='nodrag nopan h-5 text-[10px] px-1.5'
        onClick={onViewLogs}
      >
        <icons.ScrollText className='h-2.5 w-2.5 shrink-0' />
      </Button>
      {container.running ? (
        <OutputHandle type='terminal-context' id={`inst-${container.id}`}>
          <Button
            variant='ghost'
            size='sm'
            className='nodrag nopan h-5 text-[10px] px-1.5'
            onClick={onViewShell}
          >
            <icons.TerminalSquare className='h-2.5 w-2.5 shrink-0' />
            <span>Terminal</span>
          </Button>
        </OutputHandle>
      ) : null}
    </div>
  );
}

export function ApplicationNode({
  id, data, selected,
}: { id: string; data: AppData; selected?: boolean }) {
  const ctx = useNodeContext<DockerContext>(id, 'docker-in');
  const edges = useGraphEdges();
  const rf = useReactFlow();
  const dockerNodeId = ctx?.sourceNodeId;
  const serviceName = data.name || id;
  const errors = (data as AppData & { __errors?: string[] }).__errors;
  const volumeCount = useMemo(() => edges.filter((e: { target: string; targetHandle?: string }) =>
    e.target === id && e.targetHandle === 'volumes-in',
  ).length, [edges, id]);
  const containers = useDockerContainers(dockerNodeId, serviceName);
  const snapshotReceived = useDockerSnapshotReceived(dockerNodeId);
  const [busy, setBusy] = useState(false);
  const loaded = !ctx?.value || snapshotReceived;

  const runAction = useCallback(async (actionId: string, label: string) => {
    setBusy(true);
    try {
      await dispatch(id, actionId);
    } catch (err) {
      toast.error(`${label} failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [id]);

  const up = useCallback(() => runAction('start', 'Start'), [runAction]);
  const down = useCallback(() => runAction('stop', 'Stop'), [runAction]);

  const openInspector = useCallback((tab: string, containerId: string) => {
    rf.setNodes((nds) => nds.map((n: { id: string }) => ({ ...n, selected: n.id === id })));
    inspectorIntent.open(id, tab, containerId);
  }, [id, rf]);

  const openLogs = useCallback((containerId: string) => openInspector('logs', containerId), [openInspector]);
  const openShell = useCallback((containerId: string) => openInspector('terminal', containerId), [openInspector]);

  const running = containers.filter((c: ContainerInfo) => c.running);
  const stopped = containers.filter((c: ContainerInfo) => !c.running);
  const status = busy ? 'warning'
    : !loaded || !ctx?.value ? 'neutral'
      : containers.length === 0 ? 'neutral'
        : running.length === 0 ? 'error'
          : stopped.length === 0 ? 'success'
            : 'warning';

  return (
    <div className='flex flex-col gap-1.5'>
      <NodeFrame
        icon={icons.AppWindow}
        title={data.name || 'Application'}
        subtitle={running.length > 0 ? `${running.length} running` : containers.length > 0 ? 'stopped' : ''}
        status={status}
        selected={selected ?? false}
        loading={busy || !loaded}
        errors={errors}
        extra={
          <div className='flex items-center gap-1'>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              onClick={up}
              disabled={busy || (!data.image?.trim() && !data.buildContext?.trim()) || !ctx?.value}
            >
              {running.length > 0 ? (
                <icons.RotateCw className='h-2.5 w-2.5 shrink-0' />
              ) : (
                <icons.Play className='h-2.5 w-2.5 shrink-0' />
              )}
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='nodrag nopan h-5 text-[10px] px-1.5'
              onClick={down}
              disabled={busy || running.length === 0}
            >
              <icons.Square className='h-2.5 w-2.5 shrink-0' />
            </Button>
          </div>
        }
      >
        <div className='flex gap-3'>
          <div className='flex flex-col gap-1.5 shrink-0'>
            <InputHandle type='docker-context' id='docker-in'>
              <span className='text-[10px] text-muted-foreground'>Docker</span>
            </InputHandle>
            <InputHandle type='volume-mount' id='volumes-in'>
              <span className='text-[10px] text-muted-foreground'>Volumes{volumeCount > 0 ? ` (${volumeCount})` : ''}</span>
            </InputHandle>
          </div>
          {containers.length > 0 ? (
            <div className='flex flex-col gap-1 flex-1 min-w-0'>
              {containers.map((c: ContainerInfo, i: number) => (
                <InstanceCard
                  key={c.id}
                  index={i}
                  container={c}
                  onViewLogs={() => openLogs(c.id)}
                  onViewShell={() => openShell(c.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      </NodeFrame>
    </div>
  );
}

export function ApplicationInspector({
  data, updateData,
}: { nodeId: string; data: AppData; updateData: (p: Partial<AppData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Service Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='my-app'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Image</Label>
        <Input
          value={data.image ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ image: e.target.value })}
          placeholder='nginx:latest'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Ports (one per line, host:container)</Label>
        <Textarea
          value={data.ports ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ ports: e.target.value })}
          placeholder={'8080:80\n3000:3000'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Environment (one per line, KEY=VALUE)</Label>
        <Textarea
          value={data.env ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ env: e.target.value })}
          placeholder={'NODE_ENV=production\nDEBUG=false'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Secrets</Label>
        <SecretsPicker
          value={data.secrets ?? ''}
          onChange={(next: string) => updateData({ secrets: next })}
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Command (optional)</Label>
        <Textarea
          value={data.command ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ command: e.target.value })}
          placeholder='npm start'
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Entrypoint (optional, overrides image default)</Label>
        <Input
          value={data.entrypoint ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ entrypoint: e.target.value })}
          placeholder='sh -c'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>IPC mode (optional)</Label>
        <Input
          value={data.ipc ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ ipc: e.target.value })}
          placeholder='host'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>shm_size (optional)</Label>
        <Input
          value={data.shmSize ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ shmSize: e.target.value })}
          placeholder='8gb'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Replicas</Label>
        <Input
          type='number'
          value={data.replicas ?? 1}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ replicas: Number(e.target.value) || 1 })}
          placeholder='1'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Restart Policy</Label>
        <Input
          value={data.restart ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ restart: e.target.value })}
          placeholder='unless-stopped'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Container Name (optional)</Label>
        <Input
          value={data.containerName ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ containerName: e.target.value })}
          placeholder='explicit-container-name'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Working Directory (optional)</Label>
        <Input
          value={data.workingDir ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ workingDir: e.target.value })}
          placeholder='/app'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Depends On (comma-separated)</Label>
        <Input
          value={data.dependsOn ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ dependsOn: e.target.value })}
          placeholder='db, redis'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Build (alternative to Image)</Label>
      <div className='flex flex-col gap-1'>
        <Label>Build Context</Label>
        <Input
          value={data.buildContext ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ buildContext: e.target.value })}
          placeholder='./path/to/source'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Dockerfile</Label>
        <Input
          value={data.buildDockerfile ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ buildDockerfile: e.target.value })}
          placeholder='Dockerfile'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Requirements</Label>
      <div className='flex flex-col gap-1'>
        <Label>Memory limit</Label>
        <Input
          value={data.requirementMemory ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ requirementMemory: e.target.value })}
          placeholder='512m, 2g'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>vCPU limit</Label>
        <Input
          value={data.requirementCpu ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ requirementCpu: e.target.value })}
          placeholder='0.5, 2'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Runtime</Label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.gpu ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ gpu: e.target.checked })}
        />
        NVIDIA GPU
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.init ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ init: e.target.checked })}
        />
        Init (PID 1 reaping)
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.readOnly ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ readOnly: e.target.checked })}
        />
        Read-only filesystem
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.exposeHostDocker ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ exposeHostDocker: e.target.checked })}
        />
        Expose host docker
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.copyDockerBinaries ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ copyDockerBinaries: e.target.checked })}
        />
        Copy docker binaries
      </label>
      <div className='flex flex-col gap-1'>
        <Label>group_add (comma-separated)</Label>
        <Input
          value={data.groupAdd ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ groupAdd: e.target.value })}
          placeholder='988, 989'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>security_opt (one per line)</Label>
        <Textarea
          value={data.securityOpts ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ securityOpts: e.target.value })}
          placeholder='no-new-privileges:true'
          className='font-mono text-xs min-h-[40px]'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>tmpfs (one per line)</Label>
        <Textarea
          value={data.tmpfs ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ tmpfs: e.target.value })}
          placeholder={'/tmp\n/var/run/postgresql'}
          className='font-mono text-xs min-h-[40px]'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Healthcheck</Label>
      <div className='flex flex-col gap-1'>
        <Label>Test Command</Label>
        <Input
          value={data.healthcheckTest ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ healthcheckTest: e.target.value })}
          placeholder='curl -f http://localhost/health'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Interval</Label>
        <Input
          value={data.healthcheckInterval ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ healthcheckInterval: e.target.value })}
          placeholder='30s'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Timeout</Label>
        <Input
          value={data.healthcheckTimeout ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ healthcheckTimeout: e.target.value })}
          placeholder='5s'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Retries</Label>
        <Input
          type='number'
          value={data.healthcheckRetries ?? 0}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ healthcheckRetries: Number(e.target.value) || 0 })}
          placeholder='3'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Start Period</Label>
        <Input
          value={data.healthcheckStartPeriod ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ healthcheckStartPeriod: e.target.value })}
          placeholder='20s'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Traefik Proxy</Label>
      <div className='flex flex-col gap-1'>
        <Label>Domain</Label>
        <Input
          value={data.proxyDomain ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ proxyDomain: e.target.value })}
          placeholder='app.example.com'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Entrypoint</Label>
        <Input
          value={data.proxyEntrypoint ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ proxyEntrypoint: e.target.value })}
          placeholder='websecure'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Service Port</Label>
        <Input
          type='number'
          value={data.proxyPort ?? 0}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ proxyPort: Number(e.target.value) || 0 })}
          placeholder='80'
        />
      </div>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.proxyTls ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ proxyTls: e.target.checked })}
        />
        TLS (letsencrypt)
      </label>
      <div className='flex flex-col gap-1'>
        <Label>Basic Auth (user:hash)</Label>
        <Input
          value={data.proxyBasicAuth ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ proxyBasicAuth: e.target.value })}
          placeholder='admin:$apr1$...'
        />
      </div>

      <Label className='text-xs font-semibold mt-2'>Labels</Label>
      <div className='flex flex-col gap-1'>
        <Label>Custom labels (one per line, KEY=VALUE)</Label>
        <Textarea
          value={data.labels ?? ''}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateData({ labels: e.target.value })}
          placeholder={'traefik.http.routers.foo.service=api@internal\ncom.example.role=worker'}
          className='font-mono text-xs min-h-[60px]'
        />
      </div>
    </div>
  );
}

function useDockerConnection(nodeId: string) {
  const ctx = useNodeContext<DockerContext>(nodeId, 'docker-in');
  if (!ctx?.value) return null;
  const ctxValue = ctx.value;
  const ctxName = ctxValue.contextName as string | undefined;
  return { ctxValue, ctxName };
}

function resolveContainerName(data: AppData, nodeId: string): string {
  const explicit = data.containerName?.trim();
  if (explicit) {
    return explicit;
  }
  const service = data.name || nodeId;
  return `${COMPOSE_PROJECT}-${service}-1`;
}

function dockerArgs(ctxName: string | undefined, ...rest: string[]): string[] {
  return [...(ctxName ? ['--context', ctxName] : []), ...rest];
}

function buildDockerConnection(ctxValue: DockerContext, args: string[]) {
  if (ctxValue.type === 'ssh') {
    return {
      type: 'ssh' as const,
      config: {
        host: ctxValue.host, port: ctxValue.port, username: ctxValue.username,
        password: ctxValue.password, keyPath: ctxValue.keyPath,
        command: ['docker', ...args].join(' '),
      },
    };
  }
  if (ctxValue.type === 'wsl') {
    return {
      type: 'wsl' as const,
      config: { distro: ctxValue.distro, command: 'docker', args },
    };
  }
  return {
    type: 'local' as const,
    config: { command: 'docker', args },
  };
}

export function ApplicationLogsTab({
  nodeId, data,
}: { nodeId: string; data: AppData; updateData: (p: Partial<AppData>) => void }) {
  const dockerConn = useDockerConnection(nodeId);
  const intent = useInspectorIntent(nodeId);
  if (!dockerConn) {
    return (
      <div className='p-3 text-xs text-muted-foreground italic'>
        Connect a Docker node to view logs.
      </div>
    );
  }
  const { ctxValue, ctxName } = dockerConn;
  const container = intent.instanceId ?? resolveContainerName(data, nodeId);
  const args = dockerArgs(ctxName, 'logs', '-f', '--tail', '500', container);
  const connection = buildDockerConnection(ctxValue, args);
  return <InspectorTerminalBody key={container} connection={connection} />;
}

export function ApplicationTerminalTab({
  nodeId, data,
}: { nodeId: string; data: AppData; updateData: (p: Partial<AppData>) => void }) {
  const dockerConn = useDockerConnection(nodeId);
  const intent = useInspectorIntent(nodeId);
  if (!dockerConn) {
    return (
      <div className='p-3 text-xs text-muted-foreground italic'>
        Connect a Docker node to use the terminal.
      </div>
    );
  }
  const { ctxValue, ctxName } = dockerConn;
  const container = intent.instanceId ?? resolveContainerName(data, nodeId);
  const args = dockerArgs(ctxName, 'exec', '-it', container, 'bash');
  const connection = buildDockerConnection(ctxValue, args);
  return <InspectorTerminalBody key={container} connection={connection} />;
}
