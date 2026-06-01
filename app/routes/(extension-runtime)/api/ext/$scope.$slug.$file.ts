import { promises as fs } from 'node:fs';

import { createFileRoute } from '@tanstack/react-router';

import { ensureExtensionBuilt } from '@/app/(extension-runtime)/_server/loader';
import { extDistFile } from '@/app/(extension-runtime)/_server/paths';

const ALLOWED_FILES = new Set(['client.js', 'server.js']);

export const Route = createFileRoute('/(extension-runtime)/api/ext/$scope/$slug/$file')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const { scope, slug, file } = params;
        if (!ALLOWED_FILES.has(file)) {
          return new Response('Not found', { status: 404 });
        }
        const extensionId = `${scope}/${slug}`;
        try {
          await ensureExtensionBuilt(extensionId);
        } catch (err) {
          return new Response(String(err), { status: 500 });
        }
        const target = extDistFile(extensionId, file);
        try {
          const code = await fs.readFile(target, 'utf-8');
          return new Response(code, {
            status: 200,
            headers: {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          });
        } catch {
          return new Response('Bundle not found', { status: 404 });
        }
      },
    },
  },
});
