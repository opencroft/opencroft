import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

import { createServerFn } from '@tanstack/react-start';
import * as yaml from 'js-yaml';

import { CreateDockerContainerData } from '@/app/(docker)/docker/server/actions';

const DOCKER_COMMAND = ['wsl', 'docker'];
const COMPOSES_BASE_DIR = 'data/docker/composes';

function executeCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const fullCommand = `${command} ${args.join(' ')}`;
    const quiet = args.includes('json');
    console.log('$', fullCommand);

    const proc = spawn(command, args, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (!quiet) {
        process.stdout.write(chunk);
      }
    });

    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      if (!quiet) {
        process.stderr.write(chunk);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        if (stderr && !stderr.toLowerCase().includes('warning')) {
          console.error('Command stderr:', stderr);
        }
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command failed with code ${code}`));
      }
    });
  });
}

function executeDockerCommand(args: string[], context?: string): Promise<string> {
  const ctxArgs = context && context !== 'default' ? ['--context', context] : [];
  return executeCommand(DOCKER_COMMAND[0], [...DOCKER_COMMAND.slice(1), ...ctxArgs, ...args]);
}

function getComposesDir(context: string): string {
  return path.join(COMPOSES_BASE_DIR, context);
}

function composeFile(context: string, name: string): string {
  return path.join(getComposesDir(context), `${name}.yml`).replaceAll('\\', '/');
}

function composeArgs(context: string, name: string): string[] {
  const file = composeFile(context, name);
  const project = path.basename(COMPOSES_BASE_DIR);
  return ['compose', '-f', `"${file}"`, '-p', project];
}

function dumpYaml(data: Record<string, unknown>): string {
  return yaml.dump(data, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: true });
}

export interface DockerHealthcheck {
  test?: string;
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export interface DockerBuild {
  context?: string;
  dockerfile?: string;
  args?: Record<string, string>;
}

export interface DockerComposeService {
  name: string;
  image?: string;
  ports: string[];
  environment: Record<string, string>;
  volumes: string[];
  restart?: string;
  containerName?: string;
  command?: string;
  gpus?: boolean;
  healthcheck?: DockerHealthcheck;
  build?: DockerBuild;
  extraHosts?: string[];
  status?: 'running' | 'stopped' | 'unknown';
}

export interface DockerCompose {
  name: string;
  filePath: string;
  content: string;
  services: DockerComposeService[];
}

// --- Service status ---

async function getServiceStatuses(context: string, composeName: string): Promise<Record<string, 'running' | 'stopped' | 'unknown'>> {
  try {
    const output = await executeDockerCommand([
      ...composeArgs(context, composeName), 'ps', '--format', 'json',
    ], context);

    const statuses: Record<string, 'running' | 'stopped' | 'unknown'> = {};

    if (output.trim()) {
      for (const line of output.trim().split('\n')) {
        try {
          const service = JSON.parse(line);
          const name = service.Service || service.Name || '';
          const state = service.State || 'unknown';

          if (name) {
            statuses[name] = state.toLowerCase().includes('up') || state.toLowerCase().includes('running')
              ? 'running'
              : 'stopped';
          }
        } catch {
          console.error('Failed to parse service status line:', line);
        }
      }
    }

    return statuses;
  } catch {
    return {};
  }
}

// --- Parse compose services ---

function parseComposeServices(content: string, statuses: Record<string, 'running' | 'stopped' | 'unknown'> = {}): DockerComposeService[] {
  const composeData = yaml.load(content) as Record<string, unknown>;
  if (!composeData?.services) {
    return [];
  }

  const services: DockerComposeService[] = [];

  for (const [serviceName, serviceConfig] of Object.entries(composeData.services as Record<string, unknown>)) {
    const config = serviceConfig as Record<string, unknown>;

    const deploy = config.deploy as Record<string, unknown> | undefined;
    const reservations = (deploy?.resources as Record<string, unknown>)?.reservations as Record<string, unknown> | undefined;
    const hasGpu = Array.isArray(reservations?.devices) && reservations.devices.some(
      (d: unknown) => Array.isArray((d as Record<string, unknown>).capabilities) &&
        ((d as Record<string, unknown>).capabilities as string[]).includes('gpu')
    );

    const hc = config.healthcheck as Record<string, unknown> | undefined;
    const healthcheck: DockerHealthcheck | undefined = hc ? {
      test: hc.test as string | undefined,
      interval: hc.interval as string | undefined,
      timeout: hc.timeout as string | undefined,
      retries: hc.retries as number | undefined,
      startPeriod: hc.start_period as string | undefined,
    } : undefined;

    const buildConfig = config.build as Record<string, unknown> | undefined;
    const build: DockerBuild | undefined = buildConfig ? {
      context: buildConfig.context as string | undefined,
      dockerfile: buildConfig.dockerfile as string | undefined,
      args: buildConfig.args as Record<string, string> | undefined,
    } : undefined;

    services.push({
      name: serviceName,
      image: config.image as string | undefined,
      ports: Array.isArray(config.ports) ? (config.ports as string[]) : [],
      environment: (config.environment as Record<string, string>) || {},
      volumes: Array.isArray(config.volumes) ? (config.volumes as string[]) : [],
      restart: config.restart as string,
      containerName: config.container_name as string,
      command: config.command as string,
      gpus: hasGpu,
      healthcheck,
      build,
      extraHosts: Array.isArray(config.extra_hosts) ? (config.extra_hosts as string[]) : undefined,
      status: statuses[serviceName] || 'unknown',
    });
  }

  return services;
}

// --- CRUD operations ---

export const getDockerComposes = createServerFn({ method: 'POST' }).inputValidator((context: string) => context).handler(async ({ data: context }): Promise<DockerCompose[]> => {
  const dir = getComposesDir(context);
  await fs.mkdir(dir, { recursive: true });

  const files = await fs.readdir(dir);
  const ymlFiles = files.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  return Promise.all(ymlFiles.map(async (file) => {
    const filePath = path.join(dir, file);
    const content = await fs.readFile(filePath, 'utf-8');
    const name = file.replace(/\.(yml|yaml)$/, '');
    const statuses = await getServiceStatuses(context, name);
    const services = parseComposeServices(content, statuses);
    return { name, filePath, content, services };
  }));
});

export const createDockerCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name } = data;
  const dir = getComposesDir(context);
  await fs.mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${name}.yml`);
  await fs.writeFile(filePath, dumpYaml({ services: {} }), 'utf-8');
});

export const updateDockerCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string; content: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name, content } = data;
  yaml.load(content);
  await fs.writeFile(composeFile(context, name), content, 'utf-8');
});

export const deleteDockerCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name } = data;
  await fs.unlink(composeFile(context, name));
});

export const renameDockerCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; oldName: string; newName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, oldName, newName } = data;
  const content = await fs.readFile(composeFile(context, oldName), 'utf-8');
  await fs.writeFile(composeFile(context, newName), content, 'utf-8');
  await fs.unlink(composeFile(context, oldName));
});

// --- Service CRUD ---

function convertContainerDataToServiceFormat(serviceData: CreateDockerContainerData, serviceName: string): Record<string, unknown> {
  const service: Record<string, unknown> = {
    image: serviceData.image,
  };

  if (serviceData.name && serviceData.name !== serviceName) {
    service.container_name = serviceData.name;
  }

  if (serviceData.portMappings && serviceData.portMappings.length > 0) {
    service.ports = serviceData.portMappings.map(m => `${m.key}:${m.value}`);
  }

  if (serviceData.environmentVariables && serviceData.environmentVariables.length > 0) {
    service.environment = serviceData.environmentVariables.reduce((env, v) => {
      env[v.key] = v.value;
      return env;
    }, {} as Record<string, string>);
  }

  if (serviceData.volumeMappings && serviceData.volumeMappings.length > 0) {
    service.volumes = serviceData.volumeMappings.map(m => `${m.key}:${m.value}`);
  }

  if (serviceData.restart && serviceData.restart !== 'no') {
    service.restart = serviceData.restart;
  }

  if (serviceData.command) {
    service.command = serviceData.command;
  }

  if (serviceData.gpus) {
    service.deploy = {
      resources: {
        reservations: {
          devices: [{
            driver: 'nvidia',
            count: 'all',
            capabilities: ['gpu', 'compute'],
          }],
        },
      },
    };
  }

  if (serviceData.temporary) {
    service.remove = true;
  }

  if (serviceData.healthcheck) {
    const hc: Record<string, unknown> = {};
    if (serviceData.healthcheck.test) {
      hc.test = serviceData.healthcheck.test;
    }
    if (serviceData.healthcheck.interval) {
      hc.interval = serviceData.healthcheck.interval;
    }
    if (serviceData.healthcheck.timeout) {
      hc.timeout = serviceData.healthcheck.timeout;
    }
    if (serviceData.healthcheck.retries) {
      hc.retries = serviceData.healthcheck.retries;
    }
    if (serviceData.healthcheck.startPeriod) {
      hc.start_period = serviceData.healthcheck.startPeriod;
    }
    if (Object.keys(hc).length > 0) {
      service.healthcheck = hc;
    }
  }

  if (serviceData.build) {
    const build: Record<string, unknown> = {};
    if (serviceData.build.context) {
      build.context = serviceData.build.context;
    }
    if (serviceData.build.dockerfile) {
      build.dockerfile = serviceData.build.dockerfile;
    }
    if (serviceData.build.args && serviceData.build.args.length > 0) {
      build.args = serviceData.build.args.reduce((acc, v) => {
        acc[v.key] = v.value;
        return acc;
      }, {} as Record<string, string>);
    }
    if (Object.keys(build).length > 0) {
      service.build = build;
    }
  }

  if (serviceData.extraHosts && serviceData.extraHosts.length > 0) {
    service.extra_hosts = serviceData.extraHosts;
  }

  return service;
}

export const addServiceToCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string; serviceData: CreateDockerContainerData }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName, serviceData } = data;
  const file = composeFile(context, composeName);
  const content = await fs.readFile(file, 'utf-8');
  const composeData = yaml.load(content) as Record<string, unknown>;
  const service = convertContainerDataToServiceFormat(serviceData, serviceName);

  if (!composeData.services) {
    composeData.services = {};
  }
  (composeData.services as Record<string, unknown>)[serviceName] = service;

  await fs.writeFile(file, dumpYaml(composeData), 'utf-8');
});

export const updateServiceInCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; oldServiceName: string; newServiceName: string; serviceData: CreateDockerContainerData }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, oldServiceName, newServiceName, serviceData } = data;
  const file = composeFile(context, composeName);
  const content = await fs.readFile(file, 'utf-8');
  const composeData = yaml.load(content) as Record<string, unknown>;

  if (!composeData.services) {
    throw new Error('No services found in compose file');
  }

  if (oldServiceName !== newServiceName) {
    delete (composeData.services as Record<string, unknown>)[oldServiceName];
  }

  const service = convertContainerDataToServiceFormat(serviceData, newServiceName);
  (composeData.services as Record<string, unknown>)[newServiceName] = service;

  await fs.writeFile(file, dumpYaml(composeData), 'utf-8');
});

export const removeServiceFromCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName } = data;
  const file = composeFile(context, composeName);
  const content = await fs.readFile(file, 'utf-8');
  const composeData = yaml.load(content) as Record<string, unknown>;

  if (!composeData.services) {
    throw new Error('No services found in compose file');
  }

  delete (composeData.services as Record<string, unknown>)[serviceName];
  await fs.writeFile(file, dumpYaml(composeData), 'utf-8');
});

// --- Docker compose commands ---

export const upCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name } = data;
  await executeDockerCommand([...composeArgs(context, name), 'up', '-d'], context);
});

export const deployCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name } = data;
  await executeDockerCommand([...composeArgs(context, name), 'up', '-d', '--build'], context);
});

export const stopCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name } = data;
  await executeDockerCommand([...composeArgs(context, name), 'stop'], context);
});

export const downCompose = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; name: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, name } = data;
  await executeDockerCommand([...composeArgs(context, name), 'down'], context);
});

export const startService = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName } = data;
  await executeDockerCommand([...composeArgs(context, composeName), 'up', '-d', serviceName], context);
});

export const stopService = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName } = data;
  await executeDockerCommand([...composeArgs(context, composeName), 'stop', serviceName], context);
});

export const terminateService = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName } = data;
  await executeDockerCommand([...composeArgs(context, composeName), 'rm', '-sf', serviceName], context);
});

export const rebootService = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName } = data;
  await executeDockerCommand([...composeArgs(context, composeName), 'restart', serviceName], context);
});

export const deployService = createServerFn({ method: 'POST' }).inputValidator((data: { context: string; composeName: string; serviceName: string }) => data).handler(async ({ data }): Promise<void> => {
  const { context, composeName, serviceName } = data;
  await executeDockerCommand([...composeArgs(context, composeName), 'up', '-d', '--build', serviceName], context);
});
