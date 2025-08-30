'use server';

import { execFile } from 'node:child_process';

import { resolveServer } from '@/app/(legacy-app-dashboard)/nodes/server/actions';
import { remoteExec } from '@/app/(server)/server/remote';
import { type Server } from '@/app/(server)/server/types';

function localExec(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', cmd], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function wslExec(distro: string, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wsl', ['-d', distro, '--exec', 'bash', '-c', cmd], { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

interface RunParams {
  nodeType: string;
  nodeData: Record<string, unknown>;
  code: string;
}

export async function runScript({ nodeType, nodeData, code }: RunParams): Promise<string> {
  switch (nodeType) {
    case 'server': {
      const data = nodeData as { name: string; address: string; features: unknown[] };
      const server = await resolveServer({
        name: data.name,
        address: data.address,
        features: (data.features ?? []) as Server['features'],
      });
      return remoteExec(server, code);
    }
    case 'localhost':
      return localExec(code);
    case 'wsl': {
      const distro = (nodeData as { distro: string }).distro;
      return wslExec(distro, code);
    }
    default:
      throw new Error(`Unsupported node type: ${nodeType}`);
  }
}
