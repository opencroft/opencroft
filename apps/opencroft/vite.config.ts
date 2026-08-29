import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

import { ssrWatchdog } from './vite-ssr-watchdog'

// Deployed containers set this to the proxy hostname(s) they're
// reachable at. Vite has its own internal handling of this env var, but it only
// ever appends the raw string as a single allowedHosts entry (no comma-splitting),
// so a multi-host value silently fails to match any real Host header. Parse it
// ourselves so both the dev server and `vite preview` accept every listed host.
const additionalAllowedHosts = process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS?.split(',')
  .map((host) => host.trim())
  .filter(Boolean)

export default defineConfig(async ({ mode }) => {
  // Devtools are a development-only concern, and a release install carries no
  // devDependencies. Importing the plugin at module scope would make the package
  // mandatory for `vite build` and for `vite preview` (which serves production),
  // so it is loaded lazily and only for the dev server: `vite dev` is the only
  // caller with mode "development" — build and preview both run mode "production".
  const devtoolsPlugins = mode === 'development' ? [(await import('@tanstack/devtools-vite')).devtools()] : []

  return {
    server: {
      port: 9999,
      host: '0.0.0.0',
      allowedHosts: additionalAllowedHosts,
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
    preview: {
      port: 9999,
      host: '0.0.0.0',
      allowedHosts: additionalAllowedHosts,
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
        '@electric-sql/pglite',
        'pg',
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
        '@electric-sql/pglite',
        'pg',
        '@tailwindcss/node',
        '@tailwindcss/oxide',
        'lightningcss',
      ],
      // agent-client, @opencroft/terminal, and @opencroft/dashboards ship TS source
      // and must be transpiled for SSR; their native deps (ssh2, node-pty,
      // @electric-sql/pglite, pg) stay external via the list above.
      noExternal: ['agent-client', '@opencroft/terminal', '@opencroft/dashboards', '@opencroft/db-backups'],
    },
    // Defense-in-depth: the same native/server-only modules
    // external for the SSR build above are external here for the CLIENT build too, in
    // case a future change accidentally makes one reachable from client code again the
    // way _server/actions.ts's invokeExtensionActionImpl did (see extension-action-impl.ts
    // and node-actions-impl.ts for the actual fix — this is a backstop, not the fix).
    build: {
      rollupOptions: {
        external: [
          'ssh2',
          'cpu-features',
          '@lydell/node-pty',
          'esbuild',
          'esbuild-wasm',
          '@electric-sql/pglite',
          'pg',
          '@tailwindcss/node',
          '@tailwindcss/oxide',
          'lightningcss',
        ],
      },
    },
    plugins: [
      ssrWatchdog(),
      ...devtoolsPlugins,
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
        rollupConfig: {
          external: [
            /^@sentry\//,
            /^@lydell\/node-pty/,
            /^@tailwindcss\/(node|oxide)/,
            /^lightningcss/,
            /^@electric-sql\/pglite/,
          ],
        },
        traceDeps: [
          '@lydell/node-pty*',
          'tailwindcss',
          '@tailwindcss/node',
          '@tailwindcss/oxide*',
          'lightningcss*',
          'tw-animate-css',
          // postgres.wasm/postgres.data ship next to pglite's JS and are resolved via
          // `new URL(..., import.meta.url)` at runtime — Nitro's import-graph tracer
          // doesn't follow that, so without this the WASM data file is missing from
          // .output and PGlite fails with ENOENT on first query.
          '@electric-sql/pglite*',
        ],
      }),
      tailwindcss(),
      tanstackStart({
        srcDirectory: 'app',
        router: {
          routesDirectory: '.',
          // The base pattern excludes every `_`-prefixed name (that is how
          // `_server`, `_components`, `_lib` etc. stay out of the route tree).
          // `_authed` is the one exception: it is a real pathless layout route
          // (see app/_authed.tsx), not a support directory, so it is carved out
          // with a negative lookahead rather than widening the whole pattern —
          // every other `_foo` directory in the app keeps exactly the exclusion
          // it already had. The lookahead must also accept end-of-string: the
          // generator matches this pattern against bare directory dirent names
          // (e.g. "_authed", no trailing "." or "/"), so without the `|$`
          // branch the directory itself is excluded and its children are never
          // scanned, even though the sibling _authed.tsx file matches fine.
          routeFileIgnorePattern:
            '(^|/)(_(?!authed(\\.|/|$))[^_/]|router\\.|server\\.|client\\.|start\\.|routeTree\\.gen\\.)',
        },
      }),
      viteReact(),
    ],
  }
})
