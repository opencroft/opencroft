import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';

import next from 'next';
import { WebSocketServer } from 'ws';

import { setupTerminalWss } from '@/app/(terminal)/server/terminal';

const require = createRequire(import.meta.url);
const nextPkg = require('next/package.json') as { version: string };

const dev = !process.argv.includes('--prod');
const port = 9999;
const startedAt = Date.now();

function networkUrl(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        return `http://${ni.address}:${port}`;
      }
    }
  }
  return `http://0.0.0.0:${port}`;
}

function printBanner() {
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';
  console.log(`\n  ${dim}▲${reset} Next.js ${nextPkg.version}`);
  console.log(`  ${dim}- Local:${reset}        http://localhost:${port}`);
  console.log(`  ${dim}- Network:${reset}      ${networkUrl()}`);
  console.log(`\n ${dim}✓${reset} Starting...`);
}

const app = next({ dev, hostname: '0.0.0.0', port, turbopack: dev });
const handle = app.getRequestHandler();

const terminal = new WebSocketServer({ noServer: true });
setupTerminalWss(terminal);

async function main() {
  printBanner();
  await app.prepare();

  const server = createServer((req, res) => {
    handle(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://x');
    if (pathname === '/api/ws/terminal') {
      terminal.handleUpgrade(req, socket, head, (ws) => {
        terminal.emit('connection', ws, req);
      });
      return;
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const dim = '\x1b[2m';
    const reset = '\x1b[0m';
    console.log(` ${dim}✓${reset} Ready in ${Date.now() - startedAt}ms\n`);
  });
}

main();
