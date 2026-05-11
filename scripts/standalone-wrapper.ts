import http, { type Server } from 'node:http';

import { WebSocketServer } from 'ws';

import { setupTerminalWss } from '@/app/(terminal)/server/terminal';

declare const require: NodeRequire;

const wssTerminal = new WebSocketServer({ noServer: true });
setupTerminalWss(wssTerminal);

const origCreateServer = http.createServer;
http.createServer = function patchedCreateServer(this: typeof http, ...args: unknown[]): Server {
  const server = (origCreateServer as (...a: unknown[]) => Server).apply(this, args);
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '', 'http://x');
    if (pathname === '/api/ws/terminal') {
      wssTerminal.handleUpgrade(req, socket, head, (ws) => {
        wssTerminal.emit('connection', ws, req);
      });
    }
  });
  return server;
} as typeof http.createServer;

require('./server.next.js');
