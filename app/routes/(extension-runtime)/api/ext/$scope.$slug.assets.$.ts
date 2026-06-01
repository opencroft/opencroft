import { promises as fs } from 'node:fs';
import path from 'node:path';

import { createFileRoute } from '@tanstack/react-router';

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

export const Route = createFileRoute('/(extension-runtime)/api/ext/$scope/$slug/assets/$')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { scope, slug } = params;
        const segments = (params._splat ?? '').split('/').filter(Boolean);
        const extensionId = `${scope}/${slug}`;
        const assetsRoot = path.join(extDir(extensionId), 'assets');
        const target = path.join(assetsRoot, ...segments);
        if (path.relative(assetsRoot, target).startsWith('..')) {
          return new Response('Forbidden', { status: 403 });
        }
        try {
          const file = await fs.readFile(target);
          const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
          return new Response(file as unknown as BodyInit, {
            status: 200,
            headers: {
              'Content-Type': type,
              'Cache-Control': 'public, max-age=31536000, immutable',
            },
          });
        } catch {
          return new Response('Not found', { status: 404 });
        }
      },
    },
  },
});
