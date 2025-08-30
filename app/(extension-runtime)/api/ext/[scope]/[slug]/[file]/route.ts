import { promises as fs } from 'node:fs';

import { NextResponse } from 'next/server';

import { ensureExtensionBuilt } from '@/app/(extension-runtime)/_server/loader';
import { extDistFile } from '@/app/(extension-runtime)/_server/paths';

const ALLOWED_FILES = new Set(['client.js', 'server.js']);

interface RouteParams {
  params: Promise<{ scope: string; slug: string; file: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { scope, slug, file } = await params;
  if (!ALLOWED_FILES.has(file)) {
    return new NextResponse('Not found', { status: 404 });
  }
  const extensionId = `${scope}/${slug}`;
  try {
    await ensureExtensionBuilt(extensionId);
  } catch (err) {
    return new NextResponse(String(err), { status: 500 });
  }
  const target = extDistFile(extensionId, file);
  try {
    const code = await fs.readFile(target, 'utf-8');
    return new NextResponse(code, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new NextResponse('Bundle not found', { status: 404 });
  }
}
