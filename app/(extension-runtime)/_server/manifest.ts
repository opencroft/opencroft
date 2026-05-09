import { promises as fs } from 'node:fs';
import path from 'node:path';

import { builtinExtRoot, extDir, installedExtRoot, localExtRoot } from '@/app/(extension-runtime)/_server/paths';
import { type ExtensionManifest } from '@/app/(extension-runtime)/_types';

const MANIFEST_FILE = 'extension.json';

export async function readManifest(extensionId: string): Promise<ExtensionManifest> {
  const file = path.join(extDir(extensionId), MANIFEST_FILE);
  const raw = await fs.readFile(file, 'utf-8');
  const manifest = JSON.parse(raw) as ExtensionManifest;
  validateManifest(manifest, extensionId);
  return manifest;
}

export function validateManifest(manifest: ExtensionManifest, expectedId: string): void {
  if (!manifest.id) {
    throw new Error(`extension.json missing "id" field (${expectedId})`);
  }
  if (manifest.id !== expectedId) {
    throw new Error(`manifest id "${manifest.id}" does not match folder id "${expectedId}"`);
  }
  if (!manifest.version) {
    throw new Error(`extension.json missing "version" field (${expectedId})`);
  }
}

async function listScoped(root: string, scope: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const slug of entries) {
    const manifestFile = path.join(root, slug, MANIFEST_FILE);
    try {
      await fs.access(manifestFile);
    } catch {
      continue;
    }
    ids.push(`${scope}/${slug}`);
  }
  return ids;
}

export async function listAllExtensionIds(): Promise<string[]> {
  const [builtin, local, installed] = await Promise.all([
    listScoped(builtinExtRoot(), 'builtin'),
    listScoped(localExtRoot(), 'local'),
    listScoped(installedExtRoot(), 'installed'),
  ]);
  return [...builtin, ...local, ...installed];
}

export async function writeManifest(extensionId: string, manifest: ExtensionManifest): Promise<void> {
  const dir = extDir(extensionId);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, MANIFEST_FILE);
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}
