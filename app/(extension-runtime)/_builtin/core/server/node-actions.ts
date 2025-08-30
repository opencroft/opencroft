import host from '@ext/host';

import { dockerUp, dockerStopService, dockerRestartService, type DockerUpParams } from './docker';
import { fireEvent } from './event';
import { runScript, type ScriptResult } from './script';

interface ActionCtx {
  nodeId: string;
  typeId: string;
  data: Record<string, unknown>;
  params: Record<string, unknown>;
  input<T = unknown>(handleId: string): T | undefined;
  inputSource<T = unknown>(handleId: string): { sourceNodeId: string; sourceHandleId: string; contextType: string; value: T } | undefined;
  connectedSources(handleId: string): { nodeId: string; handleId: string; type?: string; data: Record<string, unknown> }[];
  containingNodes(typeId?: string): { id: string; type?: string; position: { x: number; y: number }; data: Record<string, unknown> }[];
}

interface VolumeData {
  hostPath?: string;
  containerPath?: string;
  readOnly?: boolean;
}

interface NetworkData {
  networkName?: string;
  driver?: string;
  external?: boolean;
}

interface AppData {
  name?: string;
  image?: string;
  ports?: string;
  env?: string;
  command?: string;
  entrypoint?: string;
  ipc?: string;
  shmSize?: string;
  restart?: string;
  replicas?: number;
  containerName?: string;
  workingDir?: string;
  buildContext?: string;
  buildDockerfile?: string;
  gpu?: boolean;
  requirementMemory?: string;
  requirementCpu?: string;
  init?: boolean;
  readOnly?: boolean;
  dependsOn?: string;
  groupAdd?: string;
  securityOpts?: string;
  tmpfs?: string;
  healthcheckTest?: string;
  healthcheckInterval?: string;
  healthcheckTimeout?: string;
  healthcheckRetries?: number;
  healthcheckStartPeriod?: string;
  proxyDomain?: string;
  proxyEntrypoint?: string;
  proxyTls?: boolean;
  proxyBasicAuth?: string;
  proxyPort?: number;
  exposeHostDocker?: boolean;
  copyDockerBinaries?: boolean;
  labels?: string;
  secrets?: string;
}

interface ScriptData {
  script: string;
  language: 'bash' | 'python' | 'node';
}

interface TerminalContext {
  type: 'local' | 'wsl' | 'ssh';
  [key: string]: unknown;
}

const HOST_DOCKER_MOUNTS = [
  '/var/run/docker.sock:/var/run/docker.sock',
];

const HOST_DOCKER_BINARIES = [
  '/usr/bin/docker:/usr/bin/docker:ro',
  '/usr/libexec/docker/cli-plugins/docker-compose:/usr/libexec/docker/cli-plugins/docker-compose:ro',
];

function buildVolumes(ctx: ActionCtx, data: AppData): string {
  const mounts: string[] = [];
  for (const src of ctx.connectedSources('volumes-in')) {
    const d = src.data as VolumeData;
    if (!d.hostPath || !d.containerPath) {
      continue;
    }
    mounts.push(`${d.hostPath}:${d.containerPath}${d.readOnly ? ':ro' : ''}`);
  }
  if (data.exposeHostDocker) {
    mounts.push(...HOST_DOCKER_MOUNTS);
  }
  if (data.copyDockerBinaries) {
    mounts.push(...HOST_DOCKER_BINARIES);
  }
  return mounts.join('\n');
}

function buildNetworks(ctx: ActionCtx): { name: string; driver: string; external: boolean }[] {
  return ctx.containingNodes('network')
    .map((n) => {
      const d = n.data as NetworkData;
      return {
        name: d.networkName ?? '',
        driver: d.driver ?? '',
        external: d.external ?? false,
      };
    })
    .filter((n) => n.name);
}

interface SecretRow {
  value: string;
}

async function resolveSecrets(data: AppData): Promise<Record<string, string>> {
  const names = (data.secrets ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) {
    return {};
  }
  const resolved: Record<string, string> = {};
  for (const name of names) {
    const row = await host.prisma.secret.findFirst({
      where: { key: name },
      orderBy: { createdAt: 'asc' },
    }) as SecretRow | null;
    if (!row) {
      throw new Error(`Secret "${name}" not found in any Secrets Store`);
    }
    resolved[name] = host.crypto.decrypt(row.value);
  }
  return resolved;
}

function requireDockerNodeId(ctx: ActionCtx): string {
  const source = ctx.inputSource('docker-in');
  if (!source?.sourceNodeId) {
    throw new Error('Application is not connected to a Docker node');
  }
  return source.sourceNodeId;
}

function serviceName(ctx: ActionCtx, data: AppData): string {
  return data.name || ctx.nodeId;
}

async function applicationStart(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData;
  if (!data.image?.trim() && !data.buildContext?.trim()) {
    throw new Error('Application requires an image or build context');
  }
  const dockerNodeId = requireDockerNodeId(ctx);
  const secrets = await resolveSecrets(data);
  const params: DockerUpParams = {
    dockerNodeId,
    service: serviceName(ctx, data),
    image: data.image ?? '',
    ports: data.ports ?? '',
    env: data.env ?? '',
    secrets,
    volumes: buildVolumes(ctx, data),
    command: data.command ?? '',
    entrypoint: data.entrypoint,
    ipc: data.ipc,
    shmSize: data.shmSize,
    restart: data.restart ?? '',
    replicas: data.replicas ?? 1,
    networks: buildNetworks(ctx),
    containerName: data.containerName,
    workingDir: data.workingDir,
    buildContext: data.buildContext,
    buildDockerfile: data.buildDockerfile,
    gpu: data.gpu,
    requirementMemory: data.requirementMemory,
    requirementCpu: data.requirementCpu,
    init: data.init,
    readOnly: data.readOnly,
    dependsOn: data.dependsOn,
    groupAdd: data.groupAdd,
    securityOpts: data.securityOpts,
    tmpfs: data.tmpfs,
    healthcheckTest: data.healthcheckTest,
    healthcheckInterval: data.healthcheckInterval,
    healthcheckTimeout: data.healthcheckTimeout,
    healthcheckRetries: data.healthcheckRetries,
    healthcheckStartPeriod: data.healthcheckStartPeriod,
    proxyDomain: data.proxyDomain,
    proxyEntrypoint: data.proxyEntrypoint,
    proxyTls: data.proxyTls,
    proxyBasicAuth: data.proxyBasicAuth,
    proxyPort: data.proxyPort,
    labels: data.labels,
  };
  await dockerUp(params);
}

async function applicationStop(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData;
  await dockerStopService({
    dockerNodeId: requireDockerNodeId(ctx),
    service: serviceName(ctx, data),
  });
}

async function applicationRestart(ctx: ActionCtx): Promise<void> {
  const data = ctx.data as AppData;
  await dockerRestartService({
    dockerNodeId: requireDockerNodeId(ctx),
    service: serviceName(ctx, data),
  });
}

async function scriptRun(ctx: ActionCtx): Promise<ScriptResult> {
  const data = ctx.data as ScriptData;
  if (!data.script?.trim()) {
    throw new Error('Script is empty');
  }
  const context = ctx.input<TerminalContext>('ctx-in') ?? { type: 'local' };
  return runScript({ script: data.script, language: data.language, context });
}

async function eventRun(ctx: ActionCtx): Promise<unknown> {
  return fireEvent(ctx.nodeId, ctx.params);
}

export const nodeActions = {
  application: {
    start: applicationStart,
    stop: applicationStop,
    restart: applicationRestart,
  },
  'script-bash': {
    run: scriptRun,
  },
  'script-python': {
    run: scriptRun,
  },
  'script-node': {
    run: scriptRun,
  },
  event: {
    run: eventRun,
  },
};
