import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NextResponse } from 'next/server';

import { extDir } from '@/app/(extension-runtime)/_server/paths';

const CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
};

interface RouteParams {
  params: Promise<{ scope: string; slug: string; path: string[] }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { scope, slug, path: segments } = await params;
  const extensionId = `${scope}/${slug}`;
  const assetsRoot = path.join(extDir(extensionId), 'assets');
  const target = path.join(assetsRoot, ...segments);
  if (path.relative(assetsRoot, target).startsWith('..')) {
    return new NextResponse('Forbidden', { status: 403 });
  }
  try {
    const file = await fs.readFile(target);
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
    return new NextResponse(file as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
