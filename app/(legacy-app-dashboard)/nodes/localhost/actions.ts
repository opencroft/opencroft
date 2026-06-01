import { execFile } from 'node:child_process';
import os from 'node:os';

import { createServerFn } from '@tanstack/react-start';

export interface LocalhostStats {
  os: string;
  cpu: string;
  memory: string;
  storage: string;
  hostname: string;
  platform: string;
}

export const getLocalhostStats = createServerFn().handler(async (): Promise<LocalhostStats> => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const formatBytes = (b: number) => {
    const gb = b / (1024 ** 3);
    return `${gb.toFixed(1)}G`;
  };

  const stats: LocalhostStats = {
    os: `${os.type()} ${os.release()}`,
    cpu: `${cpus.length}x ${cpus[0]?.model || os.arch()}`,
    memory: `${formatBytes(usedMem)}/${formatBytes(totalMem)}`,
    storage: await getDiskUsage(),
    hostname: os.hostname(),
    platform: os.platform(),
  };

  return stats;
});

function getDiskUsage(): Promise<string> {
  if (os.platform() === 'win32') {
    return new Promise((resolve) => {
      execFile('wmic', ['logicaldisk', 'where', 'DeviceID="C:"', 'get', 'Size,FreeSpace', '/format:csv'], { windowsHide: true }, (err, stdout) => {
        if (err) {
          resolve('unknown');
          return;
        }
        const lines = stdout.trim().split('\n').filter(Boolean);
        const last = lines[lines.length - 1];
        const parts = last.split(',');
        const free = parseInt(parts[1] || '0');
        const total = parseInt(parts[2] || '0');
        const used = total - free;
        const gb = (n: number) => `${(n / (1024 ** 3)).toFixed(0)}G`;
        resolve(`${gb(used)}/${gb(total)}`);
      });
    });
  }
  return new Promise((resolve) => {
    execFile('df', ['-h', '/'], (err, stdout) => {
      if (err) {
        resolve('unknown');
        return;
      }
      const lines = stdout.trim().split('\n');
      const parts = lines[1]?.split(/\s+/);
      resolve(parts ? `${parts[2]}/${parts[1]}` : 'unknown');
    });
  });
}
