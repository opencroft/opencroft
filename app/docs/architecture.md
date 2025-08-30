# Architecture overview

OpenCroft is a single Next.js 15 app (App Router, Turbopack dev server, port
9999). The UI is shadcn + Tailwind on top of React 19. The graph editor is
[`@xyflow/react`](https://reactflow.dev). Persistence is SQLite via Prisma 7
with the better-sqlite3 adapter. A separate WebSocket process powers the
terminal.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Browser                                                              │
│   React Flow canvas  ──►  Extensions (compiled client bundles)       │
│   Inspector / palette ─►  registry (typeId → ResolvedNode)           │
│   xterm.js  ────────────►  WebSocket (terminal sessions)             │
│   File browser  ───────►   server actions (storage adapters)         │
│   SSE listener  ───────►   real-time toasts / extension reloads      │
└──────────────────────────────────────────────────────────────────────┘
                  │                        │                  │
                  ▼                        ▼                  ▼
       Next.js server actions       MCP HTTP route      WebSocket server
       (`'use server'`)             /api/mcp            websocket/terminal.ts
                  │                        │                  │
                  ▼                        ▼                  ▼
       Prisma → SQLite              same MCP tools      ssh2 / node-pty
       Extension loader             call into the       sessions
       Graph context resolver       same server
                                    actions
```

## Route groups in `app/`

Next.js route groups (`(name)`) do not appear in URLs. They group code by
subsystem:

| Route group | Purpose |
| --- | --- |
| `(dashboard)` | Landing page (redirects to active space) and the canvas internals (`_canvas/`, `extension-system/`). |
| `(space)` | Space CRUD, the graph store, the page that mounts the canvas. |
| `(extension-runtime)` | Extension types, manifest loader, esbuild compiler, server/client hosts, the built-in `core` extension, the `/api/ext/[scope]/[slug]/` route that serves compiled bundles. |
| `(extension-editor)` | Server actions for the local extension folder layout and the editor UI. |
| `(mcp)` | The MCP HTTP server and tool definitions. |
| `(filemanager)` | Multi-backend file browser (S3, SSH, WSL, Docker). |
| `(terminal)` | xterm.js client, theme, WebSocket hook. |
| `(secrets-store)` | Server actions for the encrypted secret table. |
| `(settings)` | App settings pages and the `Setting` key-value table accessors. |
| `(ssh)` | The shared `ssh-client.ts` used by the terminal server and the core extension. |
| `(docker)` | Docker CLI helpers and pages. |
| `(docs)` | Renders this folder as in-app docs and exposes doc-management server actions. |
| `(sse)` | Server-sent-events route, store and hook. |
| `(applink)` | Custom sidebar bookmarks. |
| `(asr)` | Audio capture / speech recognition support for voice nodes. |
| `(module)`, `(server)`, `(openclaw)`, `(legacy-app-dashboard)` | Supporting and legacy slices. |

Top-level files in `app/` worth knowing: `layout.tsx` wraps the tree with
`ThemeProvider`, `SSEProvider` and `PluginProvider`. `app-layout.tsx` renders
the sidebar (custom AppLinks + dashboard + docs + settings).

## Outside `app/`

| Path | Purpose |
| --- | --- |
| `prisma/schema.prisma` | The four-table SQLite schema: `Setting`, `Secret`, `AppLink`, `Space`. |
| `server/prisma.ts` | Prisma client singleton (uses `better-sqlite3` adapter). |
| `server/crypto.ts` | `encrypt`/`decrypt` for the secrets store. |
| `server/shell.ts` | `exec(cmd)` wrapper used by the host. |
| `server/cache.ts` | `cacheDir(...parts)`. Disk cache for extensions. |
| `server/scheduler/event-scheduler.ts` | Timer/cron scheduler that fires `event` nodes. |
| `websocket/terminal.ts` | Standalone WebSocket server (port 3334) for terminals. |
| `data/extensions/local/<slug>/` | Where local extensions live on disk. |
| `components/ui/` | shadcn primitives. |
| `components/core/providers/` | App-wide React providers (Docker, FileManager, AskAI, RightSidebar). |
| `plugins/` | Reserved by `CLAUDE.md` for future dynamic plugins; not used yet. The runtime pluggability layer is the extension system. |
| `pages/` | Next.js pages-router fallback (currently empty/legacy). |

## Runtime layers

### 1. The graph layer

A **space** is one row in the `Space` table. Its `data` column is a JSON blob:
`{ nodes: [], edges: [] }`. There is exactly one active space at a time
(tracked by the `active-space-slug` setting).

`SpacesRegistry` ([app/(space)/server/store.ts:30](../%28space%29/server/store.ts#L30))
caches every space in memory on first access, migrates a legacy
`app-dashboard-mvp-graph` setting if it exists, and persists each save back to
SQLite.

The canvas (`app/(dashboard)/_canvas/flow-editor.tsx`) reads the graph through
the `fetchSpaceGraph` / `saveSpaceGraph` server-action wrappers in
`app/(space)/space/_components/space-client.ts`. Mutations are debounced 500
ms before being saved.

### 2. The extension layer

Every node type, context type, command-bar mode and settings page comes from
an **extension**. There are two kinds:

- **Built-in:** `app/(extension-runtime)/_builtin/core/`. The only one
  currently shipped (`builtin/core`, version `1.2.0`). Provides ~28 node
  types covering infrastructure, scripts, applications, integration and
  organization nodes, plus 5 context types.
- **Local:** any folder under `data/extensions/local/<slug>/` containing an
  `extension.json`. Created by the user through the extension editor or by
  MCP.

An extension always declares two halves:

- A **client bundle** (`src/client.tsx`) that calls `defineExtension(...)`
  with React components, inspector tabs and `exposeOutput` callbacks.
- A **server module** (`server/index.ts`) that exports `actions`,
  `nodeActions` and an optional `exposeOutput` for server-side context
  resolution.

Both halves are compiled by esbuild
([compiler.ts](../%28extension-runtime%29/_server/compiler.ts)) into
`<ext>/dist/client.js` and `<ext>/dist/server.js`. Imports of `react`,
`react-dom`, `@ext/host` and `@ext/ui` are rewritten to look up the host's
copies on `globalThis.__extHost`, so extensions never bring their own React.

The `/api/ext/[scope]/[slug]/[file]` route serves built bundles to the
browser. The client `loadAllExtensions()`
([_client/loader.ts](../%28extension-runtime%29/_client/loader.ts)) fetches
them and registers each declaration with the singleton `ExtensionRegistry`
([_client/registry.ts:54](../%28extension-runtime%29/_client/registry.ts#L54)).

See [extension-system.md](extension-system.md) for the manifest format,
compiler details, host APIs, hot-reload and the editor.

### 3. The context layer

Edges aren't dumb wires, they're typed. The handle definition in a node's
manifest declares `contextType` (e.g. `terminal-context`) and `role`
(`source` or `target`). Whenever a graph is saved,
`resolveGraphContexts(graph)`
([graph-context-resolver.ts](../%28extension-runtime%29/_server/graph-context-resolver.ts))
walks every edge, finds the source node's owning extension, and calls its
`exposeOutput(handleId, sourceData, typeId, sourceNodeId)`. The result is
written to the target node's `data.__resolvedContexts[targetHandleId]`. From
that point on, any node action or React render can read its inputs through
the resolver helpers without re-walking the graph.

See [contexts.md](contexts.md) for the typed-handle model.

### 4. The MCP layer

`app/(mcp)/api/mcp/route.ts` is an HTTP MCP server. The 34 tools defined in
[tools.ts](../%28mcp%29/api/mcp/tools.ts) call straight into the same server
actions the UI uses, so anything Claude can do, the UI can do, and they
operate on the same registry.

See [mcp.md](mcp.md) for the full tool list and behaviour.

### 5. Live updates

`SSEProvider` (`app/(sse)/components/`) opens an EventSource against
`/api/sse`. The server uses `lib/toast-store.ts` to broadcast toasts,
extension-rebuilt notifications and focus events to every open tab. The
canvas uses `useSSEEvents` to react: a rebuilt extension triggers an
extension reload; a `focus_node` event animates the camera; `comment_nodes`
event adds an ephemeral comment bubble.

See [sse.md](sse.md).

## Key data structures

```ts
// app/(extension-runtime)/_types.ts
ExtensionManifest { id, name, version, nodes[], contexts[], main, exports, ... }
NodeMetadata     { typeId, name, category, icon, handles[], actions[], ... }
ExtensionHandle  { id, contextType, role: 'source' | 'target', label }
NodeAction       { id, label, description, icon, inputSchema }
ResolvedContext<V> { sourceNodeId, sourceHandleId, type, value: V }
NodeActionCtx    { nodeId, typeId, data, params, input(), inputSource(), ... }
```

```ts
// app/(space)/server/types.ts
GraphData       { nodes: Record<string, unknown>[], edges: Record<string, unknown>[] }
SpaceSummary    { id, slug, name, createdAt, updatedAt }
```

```ts
// app/(extension-runtime)/_server/host.ts
GraphSnapshot       { nodes: GraphNodeRecord[], edges: GraphEdgeRecord[] }
GraphNodeRecord     { id, type?, position: {x, y}, data: Record<string, unknown> }
GraphEdgeRecord     { id, source, target, sourceHandle?, targetHandle?, data? }
ExtensionHost       { extensionId, fs, os, path, exec, prisma, settings, graph, storage, ... }
```

## Where to start reading code

- A new built-in node: `app/(extension-runtime)/_builtin/core/extension.json`,
  then `_builtin/core/src/nodes/<typeId>.tsx` for the React component, then
  `_builtin/core/server/<feature>.ts` for the server-side logic.
- A new server action: anywhere with `'use server'` at the top. Usually
  under `app/<group>/server/actions.ts` or a sibling `_actions/` folder.
- An MCP tool: `app/(mcp)/api/mcp/tools.ts` defines the schema; the same file
  has the handler in the switch below.
- The canvas: `app/(dashboard)/_canvas/flow-editor.tsx` is the entry point.
  `node-wrapper.tsx`, `node-inspector.tsx` and `node-palette.tsx` are the
  pieces around it.

## Settings and external configuration

There are no `.env`-driven feature flags. Configuration is stored in the
`Setting` table:

| Setting id | Shape | Owner |
| --- | --- | --- |
| `active-space-slug` | `{ slug }` | Spaces registry. |
| `app-dashboard-mvp-graph` | `GraphData` | Legacy single-space store, migrated on first load. |
| `extension-storage` | `{ [extensionId::key]: any }` | Extension `host.storage`. |
| `terminal-bookmarks`, `terminal-bookmark:<id>` | bookmark map | Terminal page. |
| `ai-settings` | OpenAI base URL, model defaults | `(settings)/settings/ai`. |

The only environment variable consulted at runtime is
`OPENCROFT_EXT_ROOT` (override for the local-extension folder, defaults to
`./data/extensions/local`).
