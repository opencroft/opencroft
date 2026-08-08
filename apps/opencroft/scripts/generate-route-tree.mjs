#!/usr/bin/env node

// Writes app/routeTree.gen.ts so a typecheck works in a checkout that has
// never run a dev server.
//
// The route tree is generated, not committed (`*.gen.ts` is ignored), and the
// only thing that generated it was the dev server. So the first typecheck in a
// fresh worktree failed with ~30 route-type errors -- one per route file, plus
// "Cannot find module '@/app/routeTree.gen'" -- until someone happened to know
// that starting and killing a dev server fixes it. Nothing in the output says
// so; the errors read like a broken branch.
//
// The generation itself is not reimplemented here. The router config this app
// uses (source directory, routes directory, the ignore pattern that carves out
// the one pathless layout directory) lives in vite.config.ts, and the framework
// plugin resolves it further before handing it to the generator -- so a second
// copy of that config would be a copy that silently drifts, and a drifted route
// tree is worse than an absent one.
//
// Instead this runs the real plugin against the real config. Resolving a Vite
// config invokes every plugin's `config`/`configResolved` hooks, and the route
// generator does its work in `configResolved`, so resolution alone produces the
// same file the dev server produces -- verified byte-identical -- without
// starting a server, opening a port, or building anything. The generator writes
// only when the contents differ, so this is also a no-op against an up-to-date
// tree and will not nudge a dev server that happens to be watching.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from 'vite'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await resolveConfig(
  {
    root: APP_DIR,
    configFile: resolve(APP_DIR, 'vite.config.ts'),
    // Plugin warnings still print; this only drops Vite's own startup chatter,
    // which has nothing to say about route generation.
    logLevel: 'warn',
  },
  'build',
)
