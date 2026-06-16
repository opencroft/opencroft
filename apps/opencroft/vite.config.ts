import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

import { ssrWatchdog } from './vite-ssr-watchdog'

export default defineConfig({
  server: {
    port: 9999,
    host: '0.0.0.0',
    // agent-client persists these JSON files next to the app cwd at runtime;
    // writing them must not trigger a dev reload (otherwise creating a session
    // reloads the page, which re-triggers session creation in a loop).
    // The extension compiler writes built bundles to <ext>/dist on activation;
    // watching those writes tears down the SSR environment mid-request
    // ("Vite environment ssr is unavailable"), so ignore them too.
    watch: {
      ignored: ['**/agent-profiles.json', '**/agent-config.json', '**/mcp-config.json', '**/dist/**'],
    },
  },
  resolve: {
    tsconfigPaths: true,
  },
  // Native / server-only modules must never be pulled into client dep optimization
  // or bundled for SSR — they are resolved from node_modules at runtime.
  // @tailwindcss/node + oxide + lightningcss back the runtime extension CSS
  // compiler and ship native binaries that break the bundler.
  optimizeDeps: {
    exclude: [
      'ssh2',
      'cpu-features',
      '@lydell/node-pty',
      'esbuild',
      'esbuild-wasm',
      'better-sqlite3',
      '@tailwindcss/node',
      '@tailwindcss/oxide',
      'lightningcss',
    ],
  },
  ssr: {
    external: [
      'ssh2',
      'cpu-features',
      '@lydell/node-pty',
      'esbuild',
      'esbuild-wasm',
      'better-sqlite3',
      '@tailwindcss/node',
      '@tailwindcss/oxide',
      'lightningcss',
    ],
    // agent-client, @opencroft/terminal, and @opencroft/dashboards ship TS source
    // and must be transpiled for SSR; their native deps (ssh2, node-pty,
    // better-sqlite3) stay external via the list above.
    noExternal: ['agent-client', '@opencroft/terminal', '@opencroft/dashboards'],
  },
  plugins: [
    ssrWatchdog(),
    devtools(),
    // Nitro builds the production server into .output/ and, in dev, serves the app
    // plus the extra server routes under serverDir. The terminal WebSocket lives at
    // server/routes/api/ws/terminal.ts and is mounted by features.websocket — this
    // replaces the previous hand-rolled `ws` upgrade plugin + dist/prod.mjs server.
    nitro({
      serverDir: './server',
      features: { websocket: true },
      // @lydell/node-pty must stay external (not inlined into the server bundle):
      // the bundled copy can't resolve its conpty worker script or per-platform
      // native binary at runtime. traceDeps copies the package (+ its platform
      // binary subpackage) into .output so the build stays self-contained.
      rollupConfig: { external: [/^@sentry\//, /^@lydell\/node-pty/, /^@tailwindcss\/(node|oxide)/, /^lightningcss/] },
      traceDeps: [
        '@lydell/node-pty*',
        'tailwindcss',
        '@tailwindcss/node',
        '@tailwindcss/oxide*',
        'lightningcss*',
        'tw-animate-css',
      ],
    }),
    tailwindcss(),
    tanstackStart({
      srcDirectory: 'app',
      router: {
        routesDirectory: '.',
        routeFileIgnorePattern: '(^|/)(_[^_/]|router\\.|server\\.|client\\.|start\\.|routeTree\\.gen\\.)',
      },
    }),
    viteReact(),
  ],
})
