'use server';

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cacheDir } from '@/server/cache';
import { exec } from '@/server/shell';

export interface KeyEntry {
  name: string;
  type: string;
  fingerprint: string;
  hasPublicKey: boolean;
  inWsl: boolean;
}

const isWindows = os.platform() === 'win32';

function storeDir(storeId: string): string {
  return cacheDir('ssh-keys', storeId);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function isPrivateKey(filePath: string): Promise<boolean> {
  const content = await fs.readFile(filePath, 'utf-8');
  return content.includes('PRIVATE KEY') || content.includes('-----BEGIN');
}

async function isKeyInWsl(name: string): Promise<boolean> {
  try {
    await exec('test -f ~/.ssh/keys/' + name);
    return true;
  } catch {
    return false;
  }
}

function setPermissions(filePath: string): Promise<void> {
  if (!isWindows) {
    return fs.chmod(filePath, 0o600);
  }
  return new Promise((resolve, reject) => {
    execFile('icacls', [filePath, '/inheritance:r', '/grant:r', `${os.userInfo().username}:F`], (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function listKeys(storeId: string): Promise<KeyEntry[]> {
  const dir = storeDir(storeId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const keys: KeyEntry[] = [];
  for (const name of entries) {
    if (name.endsWith('.pub')) {
      continue;
    }
    const filePath = path.join(dir, name);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      continue;
    }
    try {
      if (!await isPrivateKey(filePath)) {
        continue;
      }
    } catch {
      continue;
    }

    let type = 'unknown';
    let fingerprint = '';
    try {
      const info = await run('ssh-keygen', ['-l', '-f', filePath]);
      const match = info.match(/^\d+\s+(\S+)\s+.*\((\w+)\)/);
      if (match) {
        fingerprint = match[1];
        type = match[2];
      }
    } catch {
      // not parseable
    }

    let hasPublicKey = false;
    try {
      await fs.access(`${filePath}.pub`);
      hasPublicKey = true;
    } catch {
      // no pub
    }

    const inWsl = isWindows ? await isKeyInWsl(name) : false;
    keys.push({ name, type, fingerprint, hasPublicKey, inWsl });
  }
  return keys;
}

export async function createKey(storeId: string, name: string, keyType: string): Promise<void> {
  const dir = storeDir(storeId);
  await fs.mkdir(dir, { recursive: true });
  await run('ssh-keygen', ['-t', keyType, '-f', path.join(dir, name), '-N', '', '-q']);
}

export async function importKey(storeId: string, name: string, content: string): Promise<void> {
  const dir = storeDir(storeId);
  await fs.mkdir(dir, { recursive: true });
  const keyPath = path.join(dir, name);
  await fs.writeFile(keyPath, content);
  await setPermissions(keyPath);
}

export async function deleteKey(storeId: string, name: string): Promise<void> {
  const dir = storeDir(storeId);
  const keyPath = path.join(dir, name);
  await fs.unlink(keyPath).catch(() => {});
  await fs.unlink(`${keyPath}.pub`).catch(() => {});
}

export async function readPublicKey(storeId: string, name: string): Promise<string> {
  const keyPath = path.join(storeDir(storeId), name);
  try {
    return await fs.readFile(`${keyPath}.pub`, 'utf-8');
  } catch {
    return await run('ssh-keygen', ['-y', '-f', keyPath]);
  }
}

export async function copyKeyToWsl(storeId: string, name: string): Promise<void> {
  const keyPath = path.join(storeDir(storeId), name);
  const content = await fs.readFile(keyPath, 'utf-8');
  await exec('mkdir -p ~/.ssh/keys');
  await exec(`cat > ~/.ssh/keys/${name} << 'KEYEOF'\n${content}\nKEYEOF`);
  await exec(`chmod 600 ~/.ssh/keys/${name}`);
  try {
    const pub = await fs.readFile(`${keyPath}.pub`, 'utf-8');
    await exec(`cat > ~/.ssh/keys/${name}.pub << 'KEYEOF'\n${pub}\nKEYEOF`);
  } catch {
    // no pub
  }
}

export async function removeKeyFromWsl(name: string): Promise<void> {
  await exec(`rm -f ~/.ssh/keys/${name} ~/.ssh/keys/${name}.pub`);
}
