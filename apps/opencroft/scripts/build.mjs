import { execSync } from 'node:child_process'

import { build } from 'esbuild'

// 1. Build the TanStack Start app (client + server) into dist/
execSync('vite build', { stdio: 'inherit' })

// 2. Bundle the production Node entry (HTTP + static + WebSocket terminal) that
//    mounts the built Start fetch handler. Native/runtime modules and the built
//    server handler stay external (resolved from node_modules / dist at runtime).
await build({
  entryPoints: ['server/prod.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/prod.mjs',
  tsconfig: 'tsconfig.json',
  external: ['@lydell/node-pty', 'ssh2', 'cpu-features', 'ws', './server/server.js'],
})

console.log('> Built dist/prod.mjs (Node server with WebSocket terminal)')
