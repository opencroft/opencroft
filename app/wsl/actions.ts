import { spawn } from 'child_process';

import { createServerFn } from '@tanstack/react-start';

export interface WSLDistro {
  key: string;
  name: string;
  state: string;
  version: string;
  isDefault: boolean;
}

export const getDistros = createServerFn().handler(async (): Promise<WSLDistro[]> => {
  return new Promise((resolve, reject) => {
    const child = spawn('wsl', ['--list', '--verbose']);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf16le');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf16le');
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`WSL command failed with code ${code}: ${stderr}`));
        return;
      }

      const lines = stdout.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.includes('NAME') && !line.includes('STATE'));

      const distros: WSLDistro[] = lines.map((line, index) => {
        const parts = line.split(/\s{2,}/);
        const nameWithPrefix = parts[0]?.trim() || '';
        const isDefault = nameWithPrefix.startsWith('*');
        const name = nameWithPrefix.replace(/^\*\s*/, '').trim();
        const state = parts[1]?.trim() || 'Unknown';
        const version = parts[2]?.trim() || '';

        return {
          key: `wsl-${name}-${index}`,
          name,
          state,
          version,
          isDefault,
        };
      }).filter(distro => distro.name && distro.name !== '');

      resolve(distros);
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
});
