# OpenCroft

OpenCroft is a self-hosted platform for running infrastructure, automations and
AI agents in one place. You lay out servers, scripts, storage and agents as
nodes on a visual canvas, connect them, and drive them from the browser:
terminals, file management, scripts, schedules and chats with agents. The
platform is extensible: extensions add node types, full-page apps, tools and
HTTP routes at runtime.

This repository is the npm workspaces monorepo that contains the OpenCroft web
application and the packages it is built from.

## Features

- **Spaces and graphs** -- organize work into spaces, each holding one or more
  node canvases (graphs) and apps.
- **Nodes** -- a built-in catalog that includes Localhost, WSL and SSH servers,
  terminal and file manager windows, Bash, Python and Node.js scripts, key and
  secrets stores, API routes, events and messaging nodes. Nodes connect through
  typed handles.
- **Terminals and remote access** -- browser terminals over WebSocket, SSH
  connections and SSH key management.
- **AI agents** -- agents that live on the canvas, chat with you directly and
  in group chats, and operate the platform through an MCP endpoint. Tool
  calls can require approval, and calls are recorded in an audit log.
- **Extensions** -- install extensions from a registry or a git repository,
  or write your own in the built-in extension editor. Extensions are compiled
  by the server when they are activated.
- **Administration** -- first-run setup of an administrator account, user
  management, API tokens, audit log and scheduled database backups.
- **Storage** -- an embedded PostgreSQL database (PGlite) by default, or an
  external PostgreSQL server.

## Status

OpenCroft is under active development and has not reached a stable release.
Expect breaking changes to configuration, the database schema (migrations are
applied automatically at startup) and the user interface.

> **Experimental extension APIs:** the `@opencroft/client` and
> `@opencroft/server` extension APIs are experimental and may change without
> notice between versions.

## Requirements

- Node.js 22 or newer (`engines.node` is `>=22`; the Docker image uses Node.js 24)
- npm (the repository uses npm workspaces and a committed `package-lock.json`)
- Optional: a PostgreSQL server, if you do not want the embedded database
- Optional: Docker, to build and run the container image

## Quick start

```bash
git clone <repository-url> opencroft
cd opencroft
npm install
npm run dev
```

The development server listens on port 9999 on all interfaces. Open
`http://localhost:9999`; on first start the app shows a setup screen that
creates the first account as an administrator.

### Configuration

The server reads its configuration from environment variables. Set them in
your shell or process manager; the server does not load a `.env` file itself.

| Variable | Purpose |
| --- | --- |
| `BETTER_AUTH_SECRET` | Secret that signs session cookies. Required unless `NODE_ENV=development` (which `npm run dev` sets). Use at least 32 random characters and keep it stable; changing it signs everyone out. |
| `SECRETS_KEY` | Passphrase used to encrypt stored secrets. Falls back to a built-in default, so set your own value for any real deployment. |
| `DATABASE_URL` | A `postgres://` or `postgresql://` connection string to use an external PostgreSQL server. When unset, the embedded PGlite database is used. |
| `PGLITE_PATH` | Directory for the embedded database. Default: `data/pglite` under the app's working directory. |
| `OPENCROFT_DATA_DIR` | Data directory. Extensions live in its `extensions` directory, one folder per extension. Default: `data` under the app's working directory. |
| `OPENCROFT_CACHE_DIR` | Cache directory. Default: `.cache` under the app's working directory. |
| `EXTENSION_REGISTRIES` | Comma-separated list of additional extension registries. The default registry is always included. |
| `EXTENSIONS` | Comma-separated extensions to install at startup, as `owner.name` or `owner.name:version`. |
| `OPENCROFT_BRAND_COLOR` | Colour the instance draws its brand in: the logo, the wordmark, the tab icon, the installed app's icons. A Tailwind palette name such as `green` or `rose` (the full list is `BRAND_COLORS` in `packages/ui/src/components/ui/logo.tsx`). Default: `blue`. An unknown name logs a warning at startup and uses the default. Use it to tell instances apart, such as a staging copy from production. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enable Google sign-in when both are set. |
| `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET` | Enable Apple sign-in when both are set. |

When scripts run through `npm run <script>` at the repository root, the app's
working directory is `apps/opencroft`, so the default data lives in
`apps/opencroft/data`.

### Build and run a production server

```bash
npm run build
BETTER_AUTH_SECRET=<random-32+-chars> SECRETS_KEY=<your-passphrase> npm start
```

`npm run build` runs `vite build` between two bundle checks, producing a
Nitro server in `apps/opencroft/.output`. `npm start` runs `vite preview`,
which serves that build on port 9999.

## Docker

The repository includes a multi-stage `Dockerfile`. There is no compose file.

```bash
docker build -t opencroft .
docker run -p 9999:9999 \
  -e BETTER_AUTH_SECRET=<random-32+-chars> \
  -e SECRETS_KEY=<your-passphrase> \
  opencroft
```

The image runs `node .output/server/index.mjs` as the `node` user with
`/app` as its working directory, listens on port 9999 and includes `git` and
an SSH client. Application data is written to `/app/data`; to keep it across
container restarts, mount a volume there that the `node` user can write to.
Database migrations are applied when the server starts.

## Repository layout

```text
apps/
  opencroft/        @opencroft/app -- the web application (TanStack Start, Vite, Nitro)
packages/
  agent-chat/       React chat and agent configuration UI, plus its server wiring
  agent-client/     Agent engine: harness adapters (Agent Client Protocol), sessions, MCP
  auth/             @opencroft/auth -- authentication (Better Auth) server and client
  client/           @opencroft/client -- API surface for extension client (UI) code
  core/             @opencroft/core -- shared contracts for extension client and server code
  db/               @opencroft/db -- database schema, connection and migrations (Drizzle)
  db-backups/       @opencroft/db-backups -- scheduled database backups and backup archives
  server/           @opencroft/server -- API surface for extension server modules
  terminal/         @opencroft/terminal -- terminal sessions, SSH and the terminal UI component
  ui/               Shared UI component library (shadcn-style components)
  usage-rollup/     @opencroft/usage-rollup -- daily per-agent model usage rollups
scripts/            Shared test, typecheck and baseline scripts
```

## Extensions

An extension is a directory with an `extension.json` manifest (at least `id`
and `version`, plus what it `provides`), an optional server entry point
(`server/index.ts` or `extension.ts`) and an optional client entry point
(`src/client.tsx` or `src/index.tsx`). The server compiles extensions when it
activates them. Extensions come from three places: built into the app,
authored locally (for example in the built-in editor), or installed from a
registry or git repository.

Extensions import the host API from two packages:

- **`@opencroft/server`** -- for the server module. It re-exports the shared
  contracts from `@opencroft/core` and provides the host API (a default `host`
  plus named exports such as `fs`, `exec`, `terminal`, `ssh`, `secrets`,
  `storage` and `graph`). It also defines the contracts for what a server
  module can export: `load`/`unload` lifecycle hooks, per-app hooks and actions
  (`apps`), HTTP routes (`routes`, served under
  `/api/ext/<owner>.<name>/http/<path>`) and MCP tool handlers (`tools`).
- **`@opencroft/client`** -- for client (UI) code. It re-exports
  `@opencroft/core` and declares host-provided components such as
  `Terminal`, `SecretSelector`, `TerminalSelector` and `NodeRef`.

Both packages contain type declarations; the runtime is injected by the host
when the extension is loaded.

A minimal server module:

```ts
import type { ExtensionContext } from '@opencroft/server'

export function load(context: ExtensionContext) {
  context.registerNode({ type: 'my-node', name: 'My Node' })
}
```

> **Experimental:** the `@opencroft/client` and `@opencroft/server` extension
> APIs are experimental and may change without notice between versions. Pin
> the OpenCroft version your extension targets and expect to update it when
> you upgrade.

## Development

All commands run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the app's Vite development server. |
| `npm run build` | Builds the app for production. |
| `npm start` | Serves the production build with `vite preview`. |
| `npm run typecheck` | Runs each workspace's `typecheck` script (TypeScript `tsc --noEmit`, filtered to that package's own files). |
| `npm test` | Runs every workspace's `test` script at once, printing each workspace's report whole when it finishes, in workspace order. Each runs every `*.test.ts(x)` file through Node's test runner via `tsx`, each file in its own process. At most 16 files run at once across all workspaces together; `OPENCROFT_TEST_CONCURRENCY` sets that number for the whole run (`1` runs them one at a time). A single workspace's `npm test` runs half the machine's cores' worth of its files at once, or `OPENCROFT_TEST_CONCURRENCY`. A suite's database is in memory unless it sets `PGLITE_PATH` itself. |
| `npm run check` | Runs Biome over the tree and compares the findings with `lint-baseline.json`. Fails on findings above the baseline and on findings below it, so a fix must update the baseline in the same change. |
| `npm run check:full` | Runs `biome check` over the whole tree without the baseline. |
| `npm run fix` | Runs `biome check --write` to apply safe fixes. |
| `npm run check:baseline` | Runs the whole test suite and reports failures not listed in `test-baseline.json`. Exits non-zero on new failures. |

The app's TanStack Router route tree (`apps/opencroft/app/routeTree.gen.ts`)
is generated, not committed. The app's `typecheck` and `test` scripts
generate it before running.

Database tooling lives in the `@opencroft/db` workspace, for example
`npm run generate -w @opencroft/db` (create a migration with drizzle-kit) and
`npm run push -w @opencroft/db`.

## Documentation

User documentation, covering spaces, nodes, agents, apps, extensions and
settings, is maintained separately from this repository and is browsed inside
OpenCroft through the documentation app. Extension API details are documented
in the type declarations of `@opencroft/core`, `@opencroft/client` and
`@opencroft/server`.

## Contributing

OpenCroft is developed internally, and this repository does not accept
external contributions at this time.

## License

OpenCroft is licensed under the GNU Affero General Public License v3.0. See
[LICENSE](LICENSE) for the full text.
