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
Every variable OpenCroft reads is named `OPENCROFT_*`.

| Variable | Purpose |
| --- | --- |
| `OPENCROFT_AUTH_SECRET` | Secret that signs session cookies. When unset, one is generated on first start and kept in the key file (see [Instance keys](#instance-keys)). Use at least 32 random characters and keep it stable; changing it signs everyone out. |
| `OPENCROFT_SECRETS_KEY` | Passphrase used to encrypt stored secrets. When unset, one is generated on first start and kept in the key file (see [Instance keys](#instance-keys)). Keep it stable; stored secrets cannot be read under another key. |
| `OPENCROFT_DATABASE_URL` | A `postgres://` or `postgresql://` connection string to use an external PostgreSQL server. When unset, the embedded PGlite database is used. |
| `OPENCROFT_PGLITE_PATH` | Directory for the embedded database. Default: `data/pglite` under the app's working directory. |
| `OPENCROFT_DB_MIGRATIONS_DIR` | Directory the database migrations are read from. Default: `migrations` in `packages/db`; the Docker image sets it to where it keeps them. |
| `OPENCROFT_DATA_DIR` | Data directory. Extensions live in its `extensions` directory, one folder per extension. Default: `data` under the app's working directory. |
| `OPENCROFT_CACHE_DIR` | Cache directory. Default: `.cache` under the app's working directory. |
| `OPENCROFT_EXTENSION_REGISTRIES` | Comma-separated list of additional extension registries. The default registry is always included. |
| `OPENCROFT_EXTENSIONS` | Comma-separated extensions to install at startup, as `owner.name` or `owner.name:version`. |
| `OPENCROFT_BRAND_COLOR` | Colour the instance draws its brand in: the logo, the wordmark, the tab icon, the installed app's icons. A Tailwind palette name such as `green` or `rose` (the full list is `BRAND_COLORS` in `packages/ui/src/components/ui/logo.tsx`). Default: `blue`. An unknown name logs a warning at startup and uses the default. Use it to tell instances apart, such as a staging copy from production. |
| `OPENCROFT_GOOGLE_CLIENT_ID`, `OPENCROFT_GOOGLE_CLIENT_SECRET` | Enable Google sign-in when both are set. |
| `OPENCROFT_APPLE_CLIENT_ID`, `OPENCROFT_APPLE_CLIENT_SECRET` | Enable Apple sign-in when both are set. |
| `OPENCROFT_OPENCLAW_GATEWAY_URL`, `OPENCROFT_OPENCLAW_GATEWAY_TOKEN` | The OpenClaw gateway's URL and token for OpenClaw agents whose node leaves them unset. No other harness uses them. |

**Former names.** Earlier versions read some of these under other names. Those
names still work for now: when only the former name is set, its value is used
and the server logs once that it is deprecated; when both are set, the
`OPENCROFT_*` one is used and the log says so. Neither line contains the value.

| Former name | Now |
| --- | --- |
| `BETTER_AUTH_SECRET` | `OPENCROFT_AUTH_SECRET` |
| `SECRETS_KEY` | `OPENCROFT_SECRETS_KEY` |
| `DATABASE_URL` | `OPENCROFT_DATABASE_URL` |
| `PGLITE_PATH` | `OPENCROFT_PGLITE_PATH` |
| `DB_MIGRATIONS_DIR` | `OPENCROFT_DB_MIGRATIONS_DIR` |
| `EXTENSION_REGISTRIES` | `OPENCROFT_EXTENSION_REGISTRIES` |
| `EXTENSIONS` | `OPENCROFT_EXTENSIONS` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `OPENCROFT_GOOGLE_CLIENT_ID`, `OPENCROFT_GOOGLE_CLIENT_SECRET` |
| `APPLE_CLIENT_ID`, `APPLE_CLIENT_SECRET` | `OPENCROFT_APPLE_CLIENT_ID`, `OPENCROFT_APPLE_CLIENT_SECRET` |
| `OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN` | `OPENCROFT_OPENCLAW_GATEWAY_URL`, `OPENCROFT_OPENCLAW_GATEWAY_TOKEN` |

The session secret reaches Better Auth through its `secret` option, so the
library's own `BETTER_AUTH_SECRET` variable is not needed.

When scripts run through `npm run <script>` at the repository root, the app's
working directory is `apps/opencroft`, so the default data lives in
`apps/opencroft/data`.

### Build and run a production server

```bash
npm run build
OPENCROFT_AUTH_SECRET=<random-32+-chars> OPENCROFT_SECRETS_KEY=<your-passphrase> npm start
```

`npm run build` runs `vite build` between two bundle checks, producing a
Nitro server in `apps/opencroft/.output`. `npm start` runs `vite preview`,
which serves that build on port 9999.

## Docker

The repository includes a multi-stage `Dockerfile`. There is no compose file.

```bash
docker run -p 9999:9999 -v opencroft-data:/app/data ghcr.io/opencroft/opencroft:dev
```

Open `http://localhost:9999` and create the administrator on the setup
screen. To build the image yourself, `docker build -t opencroft .` and run
`opencroft` in place of the image name.

The image runs `node .output/server/index.mjs` as the `node` user with
`/app` as its working directory, listens on port 9999 and includes `git` and
an SSH client. Application data is written to `/app/data`; the volume keeps
it, and the instance keys with it, across restarts and new containers.
Database migrations are applied when the server starts.

### Instance keys

An instance has two keys: `OPENCROFT_AUTH_SECRET`, which signs sessions, and
`OPENCROFT_SECRETS_KEY`, which stored secrets are encrypted under. Each comes
from its environment variable when that is set. Otherwise it is generated on
the first start and saved in `instance-secrets.json` in the data directory
(`/app/data/instance-secrets.json` in the image), readable only by its owner,
and every later start reads it back. The environment variable always wins,
for each key separately. A key file written by an earlier version holds its
keys under their former names (`BETTER_AUTH_SECRET`, `SECRETS_KEY`); they are
still read, and the file is not rewritten.

While either key comes from the file, every start logs this warning, and the
setup screen and Settings → Backup & Restore show it to administrators:

> Instance keys are stored in `<path>` in the data volume. Anyone with this
> volume or its backups can use them. For production, set
> OPENCROFT_AUTH_SECRET and OPENCROFT_SECRETS_KEY from your own secret store,
> then delete the file. Deleting it without setting them makes the next start
> generate new keys: everyone is signed out and stored secrets can no longer
> be read.

**Moving the keys to environment variables:** copy each value out of the file
into your secret store, start the container with both variables set to those
same values, check that you can still sign in and that a stored secret still
reads, then delete the file. New values instead of the file's sign everyone
out and leave the stored secrets unreadable.

```bash
docker run -p 9999:9999 -v opencroft-data:/app/data \
  -e OPENCROFT_AUTH_SECRET=<value from your secret store> \
  -e OPENCROFT_SECRETS_KEY=<value from your secret store> \
  ghcr.io/opencroft/opencroft:dev
```

For a new production deployment, set both from the start: at least 32 random
characters each (`openssl rand -base64 32`), and no file is written.

**Backups do not include the key file.** Restoring a backup on another
instance needs the same `OPENCROFT_SECRETS_KEY` and `OPENCROFT_AUTH_SECRET`
as the instance it came from; Settings → Backup & Restore says where the
current ones come from, and says so when stored secrets cannot be decrypted
with the current `OPENCROFT_SECRETS_KEY`.

**Upgrading an instance that ran without a secrets key:** earlier versions
fell back to a built-in passphrase published in this repository. On its first
start after the upgrade, an instance whose stored secrets decrypt under that
passphrase saves it in the key file instead of a new one, so they stay
readable, and logs that it does. It protects nothing, since it is public: set
a new `OPENCROFT_SECRETS_KEY` and store each secret again to protect them.

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
  instance/         @opencroft/instance -- the instance's data directory and its keys (env or key file)
  server/           @opencroft/server -- API surface for extension server modules
  terminal/         @opencroft/terminal -- terminal sessions, SSH and the terminal UI component
  ui/               Shared UI component library (shadcn-style components)
  usage-rollup/     @opencroft/usage-rollup -- daily per-agent model usage rollups
docs/               Developer guides (authoring extensions)
scripts/            Shared test and typecheck scripts
```

## Extensions

An extension is a directory with an `extension.json` manifest, an optional
client entry point (`src/client.tsx`) and an optional server entry point
(`server/index.ts`). The server compiles extensions when it activates them.
Extensions come from three places: built into the app, authored locally (for
example in the built-in editor), or installed from a registry or git
repository.

Extensions import the host API from the modules of two packages:
`@opencroft/client` (`@opencroft/client/canvas`, `@opencroft/client/ui`, …)
for client code and `@opencroft/server` (`@opencroft/server/graph`,
`@opencroft/server/actions`, …) for the server module. Both contain type
declarations; the runtime is injected by the host when it builds the
extension.

**[Authoring extensions](docs/authoring-extensions.md)** is the guide: the
manifest and the client declaration, nodes, provider points, Apps, the server
module's exports, the host API by module, and how to typecheck an extension.

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
| `npm test` | Runs every workspace's `test` script at once, printing each workspace's report whole when it finishes, in workspace order. Each runs every `*.test.ts(x)` file through Node's test runner via `tsx`, each file in its own process. At most 16 files run at once across all workspaces together; `OPENCROFT_TEST_CONCURRENCY` sets that number for the whole run (`1` runs them one at a time). A single workspace's `npm test` runs half the machine's cores' worth of its files at once, or `OPENCROFT_TEST_CONCURRENCY`. A suite's database is in memory unless it sets `OPENCROFT_PGLITE_PATH` itself. Exits non-zero if any test in any workspace fails. |
| `npm run fix` | The command to run before every commit. Applies Biome's safe fixes and formatting to the files changed against the base branch (the merge-base with origin's default branch, plus uncommitted and untracked files; `npm run fix -- --all` writes every file), then runs Biome over the whole repository and `npm run typecheck`. Exits non-zero on any lint finding or type error left anywhere. |

`fix` comes from `packages/dev-tools` (`opencroft-dev`), which also holds the
Biome config every extension repository is checked with. It never writes or
lints files a shadcn or design-kit install writes: everything under a
`components.json`'s `ui` and `hooks` alias directories and the kit's
`<components>/hooks` directory, tests excepted.
`packages/agent-chat` and `packages/agent-client` follow their upstream
repositories and are left out.

The app's TanStack Router route tree (`apps/opencroft/app/routeTree.gen.ts`)
is generated, not committed. The app's `typecheck` and `test` scripts
generate it before running.

Database tooling lives in the `@opencroft/db` workspace, for example
`npm run generate -w @opencroft/db` (create a migration with drizzle-kit) and
`npm run push -w @opencroft/db`.

## Documentation

User documentation, covering spaces, nodes, agents, apps, extensions and
settings, is maintained separately from this repository and is browsed inside
OpenCroft through the documentation app. Writing an extension is described in
[Authoring extensions](docs/authoring-extensions.md), and each API member in
the type declarations of `@opencroft/core`, `@opencroft/client` and
`@opencroft/server`.

## Contributing

OpenCroft is developed internally, and this repository does not accept
external contributions at this time.

## License

OpenCroft is licensed under the GNU Affero General Public License v3.0. See
[LICENSE](LICENSE) for the full text.
