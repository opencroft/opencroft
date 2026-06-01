import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createServerFn } from '@tanstack/react-start';

import { buildExtension } from '@/app/(extension-runtime)/_server/compiler';
import { flushCache } from '@/app/(extension-runtime)/_server/loader';
import { localExtRoot } from '@/app/(extension-runtime)/_server/paths';
import { type BuildResult, type ExtensionManifest } from '@/app/(extension-runtime)/_types';

const MANIFEST_FILE = 'extension.json';

export interface LocalExtensionRecord {
  id: string;
  slug: string;
  manifest: ExtensionManifest;
  files: Record<string, string>;
  updatedAt: number;
}

function slugFromId(extensionId: string): string {
  const [scope, slug] = extensionId.split('/');
  if (scope !== 'local' || !slug) {
    throw new Error(`Expected local/<slug>, got "${extensionId}"`);
  }
  return slug;
}

function extDirPath(slug: string): string {
  return path.join(localExtRoot(), slug);
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

async function dirMtime(dir: string): Promise<number> {
  try {
    const stat = await fs.stat(dir);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

async function listFilesRecursive(dir: string, base: string = ''): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entries: any[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  const sorted = entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  for (const entry of sorted) {
    const name = String(entry.name);
    const rel = base ? `${base}/${name}` : name;
    const fullPath = path.join(dir, name);
    if (entry.isDirectory()) {
      // Skip dist, node_modules, .git
      if (['dist', 'node_modules', '.git'].includes(name)) {
        continue;
      }
      const sub = await listFilesRecursive(fullPath, rel);
      Object.assign(files, sub);
    } else {
      files[rel] = await readFileOrEmpty(fullPath);
    }
  }
  return files;
}

async function loadExtension(slug: string): Promise<LocalExtensionRecord | null> {
  const dir = extDirPath(slug);
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf-8');
  } catch {
    return null;
  }
  const manifest = JSON.parse(manifestRaw) as ExtensionManifest;
  const files = await listFilesRecursive(dir);
  return {
    id: `local/${slug}`,
    slug,
    manifest,
    files,
    updatedAt: await dirMtime(dir),
  };
}

export const listLocalExtensions = createServerFn({ strict: { output: false } }).handler(async (): Promise<LocalExtensionRecord[]> => {
  const root = localExtRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const records: LocalExtensionRecord[] = [];
  for (const slug of entries) {
    const record = await loadExtension(slug);
    if (record) {
      records.push(record);
    }
  }
  return records;
});

export const getLocalExtension = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((extensionId: string) => extensionId).handler(async ({ data: extensionId }): Promise<LocalExtensionRecord | null> => {
  return loadExtension(slugFromId(extensionId));
});

export const updateLocalExtension = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((data: { extensionId: string; files: Record<string, string> }) => data).handler(async ({ data }): Promise<LocalExtensionRecord> => {
  const { extensionId, files } = data;
  const slug = slugFromId(extensionId);
  const dir = extDirPath(slug);
  try {
    await fs.access(dir);
  } catch {
    throw new Error(`Extension ${extensionId} does not exist`);
  }

  // Write all files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  flushCache(extensionId);
  const record = await loadExtension(slug);
  if (!record) {
    throw new Error(`Failed to read extension ${extensionId} after update`);
  }
  return record;
});

export const createLocalExtension = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((files: Record<string, string>) => files).handler(async ({ data: files }): Promise<LocalExtensionRecord> => {
  const manifest = JSON.parse(files[MANIFEST_FILE]) as ExtensionManifest;
  const slug = slugFromId(manifest.id);
  const dir = extDirPath(slug);
  try {
    await fs.access(dir);
    throw new Error(`Extension ${manifest.id} already exists`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err;
    }
  }

  await fs.mkdir(dir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  flushCache(manifest.id);
  const record = await loadExtension(slug);
  if (!record) {
    throw new Error(`Failed to create extension ${manifest.id}`);
  }
  return record;
});

export const deleteLocalExtension = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((extensionId: string) => extensionId).handler(async ({ data: extensionId }): Promise<void> => {
  const slug = slugFromId(extensionId);
  const dir = extDirPath(slug);
  await fs.rm(dir, { recursive: true, force: true });
  flushCache(extensionId);
});

export const compileLocalExtension = createServerFn({ method: 'POST', strict: { output: false } }).inputValidator((extensionId: string) => extensionId).handler(async ({ data: extensionId }): Promise<BuildResult> => {
  const slug = slugFromId(extensionId);
  const record = await loadExtension(slug);
  if (!record) {
    throw new Error(`Extension ${extensionId} does not exist`);
  }
  flushCache(extensionId);
  return buildExtension(extensionId, record.manifest);
});
