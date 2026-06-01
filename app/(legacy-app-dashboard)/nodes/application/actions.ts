import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createServerFn } from '@tanstack/react-start';
import * as yaml from 'js-yaml';

import { cacheDir } from '@/server/cache';
import { prisma } from '@/server/prisma';

export interface AppService {
  name: string;
  image: string;
  ports: { host: string; container: string }[];
  env: { key: string; value: string }[];
  volumes: { host: string; container: string }[];
  restart: string;
  command: string;
}

export interface AppData {
  name: string;
  services: AppService[];
  context: string;
}

const SETTING_PREFIX = 'app-node:';

function appDir(appId: string): string {
  return cacheDir('apps', appId);
}

function composeFile(appId: string): string {
  return path.join(appDir(appId), 'docker-compose.yml');
}

function serviceToYaml(service: AppService): Record<string, unknown> {
  const svc: Record<string, unknown> = {};
  if (service.image) {
    svc.image = service.image;
  }
  if (service.ports.length > 0) {
    svc.ports = service.ports.map((p) => `${p.host}:${p.container}`);
  }
  if (service.env.length > 0) {
    svc.environment = Object.fromEntries(service.env.map((e) => [e.key, e.value]));
  }
  if (service.volumes.length > 0) {
    svc.volumes = service.volumes.map((v) => `${v.host}:${v.container}`);
  }
  if (service.restart && service.restart !== 'no') {
    svc.restart = service.restart;
  }
  if (service.command) {
    svc.command = service.command;
  }
  return svc;
}

export const loadApp = createServerFn({ method: 'POST' }).inputValidator((appId: string) => appId).handler(async ({ data: appId }): Promise<AppData | null> => {
  const row = await prisma.setting.findUnique({ where: { id: SETTING_PREFIX + appId } });
  if (!row) {
    return null;
  }
  return JSON.parse(row.data) as AppData;
});

export const saveApp = createServerFn({ method: 'POST' }).inputValidator((data: { appId: string; data: AppData }) => data).handler(async ({ data }): Promise<void> => {
  const { appId, data: appData } = data;
  await prisma.setting.upsert({
    where: { id: SETTING_PREFIX + appId },
    create: { id: SETTING_PREFIX + appId, data: JSON.stringify(appData) },
    update: { data: JSON.stringify(appData) },
  });

  const dir = appDir(appId);
  await fs.mkdir(dir, { recursive: true });

  const compose: Record<string, unknown> = {
    services: Object.fromEntries(
      appData.services.map((s) => [s.name, serviceToYaml(s)]),
    ),
  };
  await fs.writeFile(composeFile(appId), yaml.dump(compose, { sortKeys: true, indent: 2, lineWidth: -1 }));
});

export const deleteApp = createServerFn({ method: 'POST' }).inputValidator((appId: string) => appId).handler(async ({ data: appId }): Promise<void> => {
  await prisma.setting.delete({ where: { id: SETTING_PREFIX + appId } }).catch(() => {});
  const dir = appDir(appId);
  await fs.rm(dir, { recursive: true, force: true });
});

export const getContainerStatuses = createServerFn({ method: 'POST' }).inputValidator((appId: string) => appId).handler(async ({ data: appId }): Promise<Record<string, string>> => {
  const file = composeFile(appId);
  try {
    await fs.access(file);
  } catch {
    return {};
  }

  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('wsl', ['docker', 'compose', '-f', file, 'ps', '--format', 'json'], { windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({});
        return;
      }
      const statuses: Record<string, string> = {};
      for (const line of stdout.trim().split('\n')) {
        try {
          const obj = JSON.parse(line);
          statuses[obj.Service || obj.Name] = obj.State || 'unknown';
        } catch {
          // skip
        }
      }
      resolve(statuses);
    });
  });
});

export const composeUp = createServerFn({ method: 'POST' }).inputValidator((appId: string) => appId).handler(async ({ data: appId }): Promise<void> => {
  const file = composeFile(appId);
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('wsl', ['docker', 'compose', '-f', file, 'up', '-d'], { windowsHide: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
});

export const composeDown = createServerFn({ method: 'POST' }).inputValidator((appId: string) => appId).handler(async ({ data: appId }): Promise<void> => {
  const file = composeFile(appId);
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('wsl', ['docker', 'compose', '-f', file, 'down'], { windowsHide: true }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
});
