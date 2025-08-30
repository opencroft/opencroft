# OpenCroft documentation

OpenCroft is a Next.js application that gives you a visual graph workspace for
managing infrastructure: servers, containers, scripts, files, secrets and the
flows that connect them. Every box you can drag onto the canvas is a node from
an **extension**. The lines you draw between handles are typed **contexts** that
carry SSH sessions, filesystem targets, Docker daemons, etc. between nodes.

The docs split into three trees:

- **[user/](user/README.md)**: task-oriented guides for people *using*
  OpenCroft. Start here if you want to know how to deploy a service, hook
  up a script, or wire a webhook.
- **[nodes/](nodes/README.md)**: one reference page per built-in node.
  Inputs, outputs, fields, actions, examples.
- The technical docs in this folder (the rest of this index): for people
  modifying OpenCroft itself.

## Technical reference (this folder)

1. [architecture.md](architecture.md): the system at a glance. The route
   groups in `app/`, the runtime layers, where data lives.
2. [spaces-and-graph.md](spaces-and-graph.md): what a space is, how the graph
   is stored, the canvas, server-side context resolution.
3. [extension-system.md](extension-system.md): manifests, the esbuild-based
   compiler, the client and server hosts, the extension editor.
4. [contexts.md](contexts.md): typed handles, how `exposeOutput` populates
   `__resolvedContexts` on consumer nodes.
5. [node-catalog.md](node-catalog.md): every built-in node type, its handles,
   actions and the contexts it produces or consumes.
6. [mcp.md](mcp.md): the Model Context Protocol server and the tools it
   exposes for graph, extension, doc and remote-exec automation.
7. [data-persistence.md](data-persistence.md): the Prisma schema, migrations
   away from legacy settings storage, how secrets are encrypted.
8. [terminal.md](terminal.md): the standalone WebSocket terminal server and
   the xterm.js client.
9. [filemanager.md](filemanager.md): the multi-backend file browser (S3, SSH,
   WSL, Docker).
10. [sse.md](sse.md): the server-sent-events bus that broadcasts toasts,
    focus events and extension reloads to every open browser tab.

## Conventions

- File and directory references use absolute paths from the project root,
  e.g. `app/(space)/server/actions.ts`.
- Code references use the `path:line` form so VS Code can jump straight to
  the symbol.
- "Built-in" always means `app/(extension-runtime)/_builtin/core/`, the only
  built-in extension shipped with the app.
- "Local extension" always means a folder under `data/extensions/local/<slug>/`,
  written by the user (or by an MCP client) and persisted on disk.
