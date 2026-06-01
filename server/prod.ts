import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeRequest, sendNodeResponse } from 'srvx/node';
import { WebSocketServer } from 'ws';

import { setupTerminalWss } from '@/app/(terminal)/server/terminal';

// The TanStack Start server build (Web fetch handler). Resolved at runtime
// relative to dist/prod.mjs -> dist/server/server.js (kept external at bundle time).
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import handler from './server/server.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = join(dir, 'client');
const PORT = Number(process.env.PORT ?? 9999);
const HOST = process.env.HOSTNAME ?? '0.0.0.0';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

async function tryServeStatic(pathname: string, res: import('node:http').ServerResponse): Promise<boolean> {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(CLIENT_DIR, rel);
  if (!file.startsWith(CLIENT_DIR)) {
    return false;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) {
      return false;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

const terminal = new WebSocketServer({ noServer: true });
setupTerminalWss(terminal);

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && (pathname.startsWith('/assets/') || pathname === '/favicon.ico')) {
    if (await tryServeStatic(pathname, res)) {
      return;
    }
  }

  const webReq = new NodeRequest({ req, res });
  const webRes = await handler.fetch(webReq);
  if (webRes.headers.get('content-type')?.startsWith('text/html')) {
    res.setHeader('content-encoding', 'identity');
  }
  res.setHeaders(webRes.headers);
  res.writeHead(webRes.status, webRes.statusText);
  await sendNodeResponse(res, webRes);
});

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url ?? '', 'http://localhost');
  if (pathname !== '/api/ws/terminal') {
    return;
  }
  terminal.handleUpgrade(req, socket, head, (ws) => {
    terminal.emit('connection', ws, req);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`  ✓ opencroft (prod) on http://${HOST}:${PORT}`);
});
