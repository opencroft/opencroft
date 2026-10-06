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

// The `dev` script starts Vite with RAYON_NUM_THREADS capped. Rolldown,
// lightningcss and the Tailwind scanner each keep a native thread pool sized to
// the CPU count by default, and on a many-core host those pools hold hundreds
// of MB of the dev server's memory. Setting it from this file instead does not
// lower the startup peak, so it has to be in the environment Vite starts with.

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
      // Agents write freely into their workspaces and harness homes under
      // data/ (a harness clones plugins, templates and tsconfig files into its
      // home); a watched write there forces a full reload of every connected
      // browser, so neither tree is ever watched.
      watch: {
        ignored: [
          '**/agent-profiles.json',
          '**/agent-config.json',
          '**/mcp-config.json',
          '**/dist/**',
          '**/data/agent-workspace/**',
          '**/data/agent-harness-home/**',
        ],
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
    optimizeDeps: {
      // Every client dependency has to be found by the startup scan. One found
      // later, when a page first imports it, makes Vite re-bundle all
      // dependencies and full-reload every open page while the old module graph
      // is still in memory, which can take the dev server past its memory limit.
      // TanStack Start excludes from optimization every package that peer-depends
      // on it, agent-chat included, and the scan does not descend into excluded
      // packages, so agent-chat's client sources are scanned as entries of their own.
      entries: [
        '../../packages/agent-chat/src/**/*.{ts,tsx}',
        '!../../packages/agent-chat/src/server/**',
        '!../../packages/agent-chat/src/**/*test*',
      ],
      // Imported only from TanStack's own excluded client packages, so the scan
      // cannot see them either. A dependency missing here shows up in the dev
      // log as "new dependencies optimized" after the first page load.
      include: [
        '@tanstack/router-core',
        '@tanstack/router-core/isServer',
        '@tanstack/router-core/ssr/client',
        'seroval',
      ],
      // Native / server-only modules must never be pulled into client dep optimization
      // or bundled for SSR — they are resolved from node_modules at runtime.
      // @tailwindcss/node + oxide + lightningcss back the runtime extension CSS
      // compiler and ship native binaries that break the bundler.
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
        // Server-only packages imported by server functions inside route files.
        // The scan reads route sources before TanStack Start strips the server
        // code from the client build, so it would prebundle these for the
        // browser too, which costs startup memory and serves nothing.
        '@agentclientprotocol/sdk',
        '@ai-sdk/openai-compatible',
        '@aws-sdk/client-s3',
        '@aws-sdk/lib-storage',
        '@hocuspocus/server',
        '@modelcontextprotocol/sdk',
        'ai',
        'better-auth/adapters/drizzle',
        'better-auth/plugins',
        'better-auth/tanstack-start',
        'drizzle-orm',
        'sharp',
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
      // agent-client and @opencroft/terminal ship TS source and must be
      // transpiled for SSR; their native deps (ssh2, node-pty,
      // @electric-sql/pglite, pg) stay external via the list above.
      noExternal: ['agent-client', '@opencroft/terminal', '@opencroft/db-backups'],
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
        // Off: the dev server's SSR stylesheet is collected by walking each route's
        // server module graph and looking up every bare import it finds in the
        // client environment. Each lookup that is not already a client dependency
        // registers one, so the first page whose server code reaches a server-only
        // package makes Vite re-bundle all dependencies and reload every open page.
        // App styles reach the page through globals.css's link in __root.tsx;
        // stylesheets imported by components still load with the component's module.
        dev: { ssrStyles: { enabled: false } },
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
