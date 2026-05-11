import { execSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'esbuild';

execSync('next build', { stdio: 'inherit' });

const standalone = resolve('.next/standalone');
renameSync(`${standalone}/server.js`, `${standalone}/server.next.js`);

await build({
  entryPoints: ['scripts/standalone-wrapper.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['@lydell/node-pty', 'ssh2', 'ws', './server.next.js'],
  tsconfig: 'tsconfig.json',
  outfile: `${standalone}/server.js`,
});

console.log(`> Wrapped Next standalone ${standalone}/server.js with WebSocket upgrade handler`);
