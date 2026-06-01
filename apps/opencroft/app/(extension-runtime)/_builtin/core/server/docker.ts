import host from '@ext/host';
import * as yaml from 'js-yaml';

import { COMPOSE_PROJECT } from '../shared';
import { ensureRegistryLogin } from './registry';
import { resolveKeyContent } from './ssh';
import { type TerminalContext, terminalExec, terminalRun } from './terminal';

const isWindows = host.os.platform() === 'win32';

export interface DockerContext extends TerminalContext {
  contextName?: string;
  dockerHost?: string;
  targetKeyPath?: string;
  dockerNodeId?: string;
}

interface ResolvedHandle {
  value?: TerminalContext;
}

interface DockerNodeData {
  contextName?: string;
  __resolvedContexts?: Record<string, ResolvedHandle>;
}

function buildDockerHost(target: TerminalContext | undefined): string | undefined {
  if (!target || target.type !== 'ssh' || !target.host) {
    return undefined;
  }
  const user = (target.username as string) || 'root';
  const port = (target.port as number) || 22;
  return `ssh://${user}@${target.host}:${port}`;
}

async function resolveDockerContext(dockerNodeId: string): Promise<DockerContext> {
  const node = await host.graph.getNode(dockerNodeId);
  if (!node) {
    throw new Error(`Docker node ${dockerNodeId} not found`);
  }
  const data = node.data as DockerNodeData;
  const exec = data.__resolvedContexts?.['ctx-in']?.value ?? { type: 'local' };
  const target = data.__resolvedContexts?.['context-in']?.value;
  return {
    ...exec,
    contextName: data.contextName,
    dockerHost: buildDockerHost(target),
    targetKeyPath: target?.keyPath as string | undefined,
    dockerNodeId,
  };
}

function composeFilePath(dockerNodeId: string): string {
  return host.cacheDir('docker', `${dockerNodeId}.yml`);
}

function toWslPath(winPath: string): string {
  return winPath.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_, d: string) => `/mnt/${d.toLowerCase()}`);
}

function resolvedComposePath(dockerNodeId: string): string {
  const file = composeFilePath(dockerNodeId);
  return isWindows ? toWslPath(file) : file;
}

function dockerHostArgs(ctx: DockerContext): string[] {
  if (ctx.dockerHost) {
    return ['-H', ctx.dockerHost];
  }
  if (ctx.contextName) {
    return ['--context', ctx.contextName];
  }
  return [];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function resolveTargetKey(keyPath: string): Promise<string> {
  const content = await resolveKeyContent(keyPath);
  if (!content) {
    throw new Error(`Unable to resolve key for docker context: ${keyPath}`);
  }
  return content.endsWith('\n') ? content : content + '\n';
}

async function dockerCmd(ctx: DockerContext, args: string[]): Promise<string> {
  const cmd = ['docker', ...dockerHostArgs(ctx), ...args];

  if (!ctx.dockerHost || !ctx.targetKeyPath) {
    return terminalRun(ctx, cmd);
  }

  const keyContent = await resolveTargetKey(ctx.targetKeyPath);
  const keyDir = `/tmp/opencroft-docker-keys/${ctx.dockerNodeId ?? 'unknown'}`;
  const keyFile = `${keyDir}/id`;
  const script = [
    'set -e',
    'umask 077',
    `mkdir -p ${shellQuote(keyDir)}`,
    `cat > ${shellQuote(keyFile)} << 'OPENCROFT_KEY_EOF'`,
    keyContent.trimEnd(),
    'OPENCROFT_KEY_EOF',
    `chmod 600 ${shellQuote(keyFile)}`,
    'eval "$(ssh-agent -s)" >/dev/null',
    `trap 'ssh-agent -k >/dev/null 2>&1; rm -rf ${shellQuote(keyDir)}' EXIT`,
    `ssh-add ${shellQuote(keyFile)}`,
    cmd.map(shellQuote).join(' '),
  ].join('\n');
  return terminalExec(ctx, script);
}

async function composeCmd(ctx: DockerContext, dockerNodeId: string, args: string[]): Promise<string> {
  return dockerCmd(ctx, ['compose', '-f', resolvedComposePath(dockerNodeId), '-p', COMPOSE_PROJECT, ...args]);
}

// ═══════════════════════════════════════════════════════════════════
// Compose file read/write — single file per Docker node
// ═══════════════════════════════════════════════════════════════════

interface ComposeDoc {
  services: Record<string, Record<string, unknown>>;
  networks?: Record<string, Record<string, unknown>>;
}

async function readCompose(dockerNodeId: string): Promise<ComposeDoc> {
  const file = composeFilePath(dockerNodeId);
  try {
    const content = await host.fs.readFile(file, 'utf-8');
    const doc = yaml.load(content) as ComposeDoc;
    return { services: doc?.services ?? {}, networks: doc?.networks };
  } catch {
    return { services: {} };
  }
}

async function writeCompose(dockerNodeId: string, doc: ComposeDoc): Promise<void> {
  const file = composeFilePath(dockerNodeId);
  await host.fs.mkdir(host.path.dirname(file), { recursive: true });
  const content = yaml.dump(doc, { indent: 2, lineWidth: -1, noRefs: true });
  await host.fs.writeFile(file, content, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
// Docker availability check
// ═══════════════════════════════════════════════════════════════════

export interface DockerCheckParams {
  dockerNodeId: string;
}

export async function dockerCheck(params: DockerCheckParams): Promise<boolean> {
  try {
    const ctx = await resolveDockerContext(params.dockerNodeId);
    const out = await dockerCmd(ctx, ['version', '--format', '{{.Server.Version}}']);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Container queries
// ═══════════════════════════════════════════════════════════════════

export interface ContainerInfo {
  id: string;
  name: string;
  service: string;
  status: string;
  running: boolean;
}

export interface DockerPsParams {
  dockerNodeId: string;
  service?: string;
}

const PS_CACHE_TTL = 10_000;

interface PsCacheEntry {
  containers: ContainerInfo[];
  expires: number;
  inflight?: Promise<ContainerInfo[]>;
}

const psCache = new Map<string, PsCacheEntry>();

async function fetchPs(ctx: DockerContext, dockerNodeId: string): Promise<ContainerInfo[]> {
  const args = [
    'ps', '-a',
    '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--format', '{{.ID}}\\t{{.Names}}\\t{{.Label "com.docker.compose.service"}}\\t{{.Status}}\\t{{.State}}',
  ];
  let out = '';
  try {
    out = await dockerCmd(ctx, args);
  } catch (err) {
    console.error(`[docker.ps] failed for ${dockerNodeId}:`, err);
    return [];
  }
  if (!out.trim()) {
    return [];
  }
  return out.trim().split('\n').map((line) => {
    const [id, name, service, status, state] = line.split('\t');
    return { id, name, service, status, running: state === 'running' };
  });
}

function invalidatePs(dockerNodeId: string): void {
  psCache.delete(dockerNodeId);
  const fn = (globalThis as { __dockerPsInvalidated?: (id: string) => void }).__dockerPsInvalidated;
  if (fn) {
    fn(dockerNodeId);
  }
}

async function getPsCached(ctx: DockerContext, dockerNodeId: string): Promise<ContainerInfo[]> {
  const entry = psCache.get(dockerNodeId);
  if (entry && entry.expires > Date.now()) {
    return entry.containers;
  }
  if (entry?.inflight) {
    return entry.inflight;
  }
  const inflight = fetchPs(ctx, dockerNodeId).then((containers) => {
    psCache.set(dockerNodeId, { containers, expires: Date.now() + PS_CACHE_TTL });
    return containers;
  });
  psCache.set(dockerNodeId, { containers: entry?.containers ?? [], expires: 0, inflight });
  return inflight;
}

export async function dockerPs(params: DockerPsParams): Promise<ContainerInfo[]> {
  try {
    await host.fs.access(composeFilePath(params.dockerNodeId));
  } catch {
    return [];
  }
  const ctx = await resolveDockerContext(params.dockerNodeId);
  const all = await getPsCached(ctx, params.dockerNodeId);
  if (params.service) {
    return all.filter((c) => c.service === params.service);
  }
  return all;
}

// ═══════════════════════════════════════════════════════════════════
// Full container/image listings (any container/image on the host)
// ═══════════════════════════════════════════════════════════════════

export interface DockerListParams {
  dockerNodeId: string;
}

export interface ContainerListItem {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  created: string;
  ports: string;
  running: boolean;
}

export async function dockerListContainers(params: DockerListParams): Promise<ContainerListItem[]> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  const args = [
    'ps', '-a',
    '--format', '{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}\\t{{.CreatedAt}}\\t{{.Ports}}',
  ];
  let out = '';
  try {
    out = await dockerCmd(ctx, args);
  } catch (err) {
    console.error(`[docker.listContainers] failed for ${params.dockerNodeId}:`, err);
    return [];
  }
  if (!out.trim()) {
    return [];
  }
  return out.trim().split('\n').map((line) => {
    const [id, name, image, status, state, created, ports] = line.split('\t');
    return { id, name, image, status, state, created, ports: ports ?? '', running: state === 'running' };
  });
}

export interface ImageListItem {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface DockerContainerActionParams {
  dockerNodeId: string;
  containerId: string;
}

export async function dockerStartContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await dockerCmd(ctx, ['start', params.containerId]);
  invalidatePs(params.dockerNodeId);
}

export async function dockerStopContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await dockerCmd(ctx, ['stop', params.containerId]);
  invalidatePs(params.dockerNodeId);
}

export async function dockerRestartContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await dockerCmd(ctx, ['restart', params.containerId]);
  invalidatePs(params.dockerNodeId);
}

export async function dockerRemoveContainer(params: DockerContainerActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await dockerCmd(ctx, ['rm', '-f', params.containerId]);
  invalidatePs(params.dockerNodeId);
}

export interface DockerImageActionParams {
  dockerNodeId: string;
  imageId: string;
}

export async function dockerRemoveImage(params: DockerImageActionParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await dockerCmd(ctx, ['rmi', '-f', params.imageId]);
}

export interface DockerImagePullParams {
  dockerNodeId: string;
  reference: string;
}

export async function dockerPullImage(params: DockerImagePullParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await ensureRegistryLogin(ctx, params.dockerNodeId, params.reference);
  await dockerCmd(ctx, ['pull', params.reference]);
}

export interface DockerCheckImageUpdateParams {
  dockerNodeId: string;
  image: string;
}

export interface DockerCheckImageUpdateResult {
  localDigest?: string;
  remoteDigest?: string;
  hasUpdate: boolean;
}

async function readLocalDigest(ctx: DockerContext, image: string): Promise<string | undefined> {
  try {
    const out = await dockerCmd(ctx, ['image', 'inspect', image, '--format', '{{join .RepoDigests "\\n"}}']);
    const first = out.trim().split('\n')[0];
    if (first.includes('@')) {
      return first.split('@')[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function readRemoteDigest(ctx: DockerContext, image: string): Promise<string | undefined> {
  try {
    const out = await dockerCmd(ctx, ['buildx', 'imagetools', 'inspect', image]);
    const match = out.match(/^Digest:\s+(sha256:[a-f0-9]+)/m);
    if (match) {
      return match[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function dockerCheckImageUpdate(params: DockerCheckImageUpdateParams): Promise<DockerCheckImageUpdateResult> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await ensureRegistryLogin(ctx, params.dockerNodeId, params.image);
  const [localDigest, remoteDigest] = await Promise.all([
    readLocalDigest(ctx, params.image),
    readRemoteDigest(ctx, params.image),
  ]);
  const hasUpdate = !!localDigest && !!remoteDigest && localDigest !== remoteDigest;
  return { localDigest, remoteDigest, hasUpdate };
}

export async function dockerListImages(params: DockerListParams): Promise<ImageListItem[]> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  const args = [
    'images',
    '--format', '{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}',
  ];
  let out = '';
  try {
    out = await dockerCmd(ctx, args);
  } catch (err) {
    console.error(`[docker.listImages] failed for ${params.dockerNodeId}:`, err);
    return [];
  }
  if (!out.trim()) {
    return [];
  }
  return out.trim().split('\n').map((line) => {
    const [id, repository, tag, size, created] = line.split('\t');
    return { id, repository, tag, size, created };
  });
}

// ═══════════════════════════════════════════════════════════════════
// Service lifecycle — merges into shared compose
// ═══════════════════════════════════════════════════════════════════

interface NetworkConfig {
  name: string;
  driver: string;
  external: boolean;
}

export interface DockerUpParams {
  dockerNodeId: string;
  service: string;
  image: string;
  ports: string;
  env: string;
  secrets?: Record<string, string>;
  volumes: string;
  command: string;
  entrypoint?: string;
  ipc?: string;
  shmSize?: string;
  restart: string;
  replicas: number;
  networks: NetworkConfig[];
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
  labels?: string;
}

function linesToArray(s: string): string[] {
  return (s || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function escapeCompose(value: string): string {
  return value.split('$').join('$$');
}

function buildServiceDef(params: DockerUpParams): Record<string, unknown> {
  const svc: Record<string, unknown> = {};

  // Image or build
  if (params.buildContext) {
    svc.build = params.buildDockerfile
      ? { context: params.buildContext, dockerfile: params.buildDockerfile }
      : params.buildContext;
    if (params.image) {
      svc.image = params.image;
    }
  } else if (params.image) {
    svc.image = params.image;
  }

  if (params.containerName) {
    svc.container_name = params.containerName;
  }
  if (params.workingDir) {
    svc.working_dir = params.workingDir;
  }

  const ports = linesToArray(params.ports);
  if (ports.length > 0) {
    svc.ports = ports;
  }
  const envLines = linesToArray(params.env);
  const environment: Record<string, string> = {};
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      environment[line.slice(0, eq)] = escapeCompose(line.slice(eq + 1));
    }
  }
  for (const [name, value] of Object.entries(params.secrets ?? {})) {
    environment[name] = escapeCompose(value);
  }
  if (Object.keys(environment).length > 0) {
    svc.environment = environment;
  }
  const vols = linesToArray(params.volumes);
  if (vols.length > 0) {
    svc.volumes = vols;
  }
  if (params.entrypoint) {
    const parts = params.entrypoint.split(/\s+/).filter(Boolean).map(escapeCompose);
    svc.entrypoint = parts;
    if (params.command) {
      svc.command = [escapeCompose(params.command)];
    }
  } else if (params.command) {
    svc.command = escapeCompose(params.command);
  }
  if (params.ipc) {
    svc.ipc = params.ipc;
  }
  if (params.shmSize) {
    svc.shm_size = params.shmSize;
  }
  if (params.restart) {
    svc.restart = params.restart;
  }

  // Dependencies
  const deps = (params.dependsOn || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (deps.length > 0) {
    svc.depends_on = deps;
  }

  // Security
  if (params.init) {
    svc.init = true;
  }
  if (params.readOnly) {
    svc.read_only = true;
  }
  const groups = (params.groupAdd || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (groups.length > 0) {
    svc.group_add = groups;
  }
  const secOpts = linesToArray(params.securityOpts || '');
  if (secOpts.length > 0) {
    svc.security_opt = secOpts;
  }
  const tmpfsMounts = linesToArray(params.tmpfs || '');
  if (tmpfsMounts.length > 0) {
    svc.tmpfs = tmpfsMounts;
  }

  // Healthcheck
  if (params.healthcheckTest) {
    const hc: Record<string, unknown> = {
      test: ['CMD-SHELL', escapeCompose(params.healthcheckTest)],
    };
    if (params.healthcheckInterval) {
      hc.interval = params.healthcheckInterval;
    }
    if (params.healthcheckTimeout) {
      hc.timeout = params.healthcheckTimeout;
    }
    if (params.healthcheckRetries && params.healthcheckRetries > 0) {
      hc.retries = params.healthcheckRetries;
    }
    if (params.healthcheckStartPeriod) {
      hc.start_period = params.healthcheckStartPeriod;
    }
    svc.healthcheck = hc;
  }

  // Deploy (replicas + GPU + resource limits)
  const replicas = params.replicas || 1;
  const deploy: Record<string, unknown> = {};
  if (replicas > 1) {
    deploy.replicas = replicas;
  }
  const resources: Record<string, unknown> = {};
  const limits: Record<string, unknown> = {};
  if (params.requirementMemory) {
    limits.memory = params.requirementMemory;
  }
  if (params.requirementCpu) {
    limits.cpus = params.requirementCpu;
  }
  if (Object.keys(limits).length > 0) {
    resources.limits = limits;
  }
  if (params.gpu) {
    resources.reservations = {
      devices: [{
        driver: 'nvidia',
        count: 'all',
        capabilities: ['gpu'],
      }],
    };
  }
  if (Object.keys(resources).length > 0) {
    deploy.resources = resources;
  }
  if (Object.keys(deploy).length > 0) {
    svc.deploy = deploy;
  }

  // Labels: auto-generated Traefik labels + user-defined, user wins on conflict
  const labels: Record<string, string> = {};
  if (params.proxyDomain) {
    const router = params.service;
    labels['traefik.enable'] = 'true';
    labels[`traefik.http.routers.${router}.rule`] = `Host(\`${params.proxyDomain}\`)`;
    if (params.proxyEntrypoint) {
      labels[`traefik.http.routers.${router}.entrypoints`] = params.proxyEntrypoint;
    }
    if (params.proxyTls) {
      labels[`traefik.http.routers.${router}.tls`] = 'true';
      labels[`traefik.http.routers.${router}.tls.certresolver`] = 'letsencrypt';
    }
    if (params.proxyPort && params.proxyPort > 0) {
      labels[`traefik.http.services.${router}.loadbalancer.server.port`] = String(params.proxyPort);
    }
    if (params.proxyBasicAuth) {
      labels[`traefik.http.middlewares.${router}-auth.basicauth.users`] = escapeCompose(params.proxyBasicAuth);
      labels[`traefik.http.routers.${router}.middlewares`] = `${router}-auth`;
    }
  }
  for (const line of linesToArray(params.labels || '')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      labels[line.slice(0, eq)] = escapeCompose(line.slice(eq + 1));
    }
  }
  if (Object.keys(labels).length > 0) {
    svc.labels = labels;
  }

  if (params.networks && params.networks.length > 0) {
    svc.networks = params.networks.map((n) => n.name);
  }
  return svc;
}

export async function dockerUp(params: DockerUpParams): Promise<void> {
  const doc = await readCompose(params.dockerNodeId);
  doc.services[params.service] = buildServiceDef(params);
  // Merge top-level networks from all services
  if (params.networks && params.networks.length > 0) {
    if (!doc.networks) {
      doc.networks = {};
    }
    for (const net of params.networks) {
      if (!doc.networks[net.name]) {
        const netDef: Record<string, unknown> = {};
        if (net.driver) {
          netDef.driver = net.driver;
        }
        if (net.external) {
          netDef.external = true;
        }
        doc.networks[net.name] = Object.keys(netDef).length > 0 ? netDef : {};
      }
    }
  }
  await writeCompose(params.dockerNodeId, doc);
  const upArgs = ['up', '-d'];
  if (params.buildContext) {
    upArgs.push('--build');
  }
  upArgs.push(params.service);
  const ctx = await resolveDockerContext(params.dockerNodeId);
  if (params.image) {
    await ensureRegistryLogin(ctx, params.dockerNodeId, params.image);
  }
  await composeCmd(ctx, params.dockerNodeId, upArgs);
  invalidatePs(params.dockerNodeId);
}

export interface DockerDownParams {
  dockerNodeId: string;
}

export async function dockerDown(params: DockerDownParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await composeCmd(ctx, params.dockerNodeId, ['down']);
  invalidatePs(params.dockerNodeId);
}

export interface DockerStopServiceParams {
  dockerNodeId: string;
  service: string;
}

export async function dockerStopService(params: DockerStopServiceParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await composeCmd(ctx, params.dockerNodeId, ['stop', params.service]);
  await composeCmd(ctx, params.dockerNodeId, ['rm', '-f', params.service]).catch(() => {});
  const doc = await readCompose(params.dockerNodeId);
  delete doc.services[params.service];
  await writeCompose(params.dockerNodeId, doc);
  invalidatePs(params.dockerNodeId);
}

export interface DockerRestartServiceParams {
  dockerNodeId: string;
  service: string;
}

export async function dockerRestartService(params: DockerRestartServiceParams): Promise<void> {
  const ctx = await resolveDockerContext(params.dockerNodeId);
  await composeCmd(ctx, params.dockerNodeId, ['restart', params.service]);
  invalidatePs(params.dockerNodeId);
}

// ═══════════════════════════════════════════════════════════════════
// Terminal config for docker exec
// ═══════════════════════════════════════════════════════════════════

export interface DockerTerminalConfigParams {
  context: DockerContext;
  containerId: string;
}

interface TerminalConfig {
  type: string;
  config: Record<string, unknown>;
}

export function dockerTerminalConfig(params: DockerTerminalConfigParams): TerminalConfig {
  const { context, containerId } = params;
  const ctxArgs = context.contextName ? ['--context', context.contextName] : [];
  const execArgs = [...ctxArgs, 'exec', '-it', containerId, 'bash'];

  if (context.type === 'ssh') {
    return {
      type: 'ssh',
      config: {
        host: context.host,
        port: context.port || 22,
        username: context.username || 'root',
        password: context.password,
        keyPath: context.keyPath,
        command: `docker ${execArgs.join(' ')}`,
      },
    };
  }

  return {
    type: 'wsl',
    config: {
      distro: context.distro,
      command: 'docker',
      args: execArgs,
    },
  };
}
