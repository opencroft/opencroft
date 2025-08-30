import fs from 'fs/promises';
import path from 'path';

import { NextResponse } from 'next/server';

const DOCS_ROOT = process.env.OPENCROFT_DOCS_ROOT ?? path.join(process.cwd(), 'app', 'docs');

interface DocEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: DocEntry[];
}

function isPathSafe(filePath: string): boolean {
  const resolved = path.resolve(DOCS_ROOT, filePath);
  return resolved.startsWith(DOCS_ROOT);
}

async function readDirRecursive(dirPath: string): Promise<DocEntry[]> {
  const resolved = path.resolve(DOCS_ROOT, dirPath);
  try {
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    const results: DocEntry[] = [];
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      const fullPath = path.join(resolved, entry.name);
      const relativePath = path.relative(DOCS_ROOT, fullPath);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const children = await readDirRecursive(relativePath);
        if (children.some(c => c.type === 'file' || (c.type === 'directory' && c.children && c.children.length > 0))) {
          results.push({ name: entry.name, path: relativePath, type: 'directory', children });
        }
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({ name: entry.name, path: relativePath, type: 'file' });
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const filePath = searchParams.get('file');

  if (filePath) {
    if (!isPathSafe(filePath) || !filePath.endsWith('.md')) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }
    try {
      const content = await fs.readFile(path.resolve(DOCS_ROOT, filePath), 'utf-8');
      return NextResponse.json({ content, name: path.basename(filePath) });
    } catch {
      return NextResponse.json({ error: 'File not found' }, { status: 404 });
    }
  }

  const tree = await readDirRecursive('');
  return NextResponse.json(tree);
}
