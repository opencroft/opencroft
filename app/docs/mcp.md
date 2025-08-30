# MCP integration

OpenCroft ships an HTTP MCP server at `/api/mcp` so AI agents (Claude
Desktop, Claude Code, your own client) can drive the same workflows the UI
drives: list spaces, edit graphs, run shell commands on remote nodes, edit
docs, and so on.

The server speaks the standard Model Context Protocol JSON-RPC. There's no
SSE transport: every call is a regular HTTP request, but UI feedback (toasts,
focus events) is broadcast through the app's [SSE bus](sse.md) so any open
canvas reacts in real time.

## Where it lives

```
app/(mcp)/
└── api/mcp/
    ├── route.ts      # HTTP transport
    └── tools.ts      # tool definitions + handlers (this is where the work happens)
```

[`tools.ts`](../%28mcp%29/api/mcp/tools.ts) is split into two halves:

- `toolDefinitions[]`: JSON-Schema descriptions for the MCP `tools/list`
  reply.
- A `ToolHandler` registry: each handler reads its args, calls into the
  same server actions the UI uses, and returns a JSON object.

## Tool catalog

### Spaces

| Tool | Maps to |
| --- | --- |
| `list_spaces` | `listSpaces()` |
| `create_space(name)` | `createSpace(name)` |
| `rename_space(space, name)` | `renameSpace(slug, name)` |
| `delete_space(space)` | `deleteSpace(slug)` (refuses the last `default`) |

Every other graph-scoped tool accepts an optional `space` argument (slug or
case-insensitive name). When omitted, the active space is used.

### Nodes

| Tool | Notes |
| --- | --- |
| `list_nodes` | Compact `{ id, name }[]`. |
| `find_nodes(patterns)` | Glob match (case-insensitive) over node `name`, `type` and any string fields in `data`. |
| `get_nodes(nodeIds)` | `{ found: [...], missing: [...] }`. Each found node carries a `handles: { input, output }` map: `input[handleId] = "node-id/handle-id"` (the connected source) or `null`; `output[handleId]` is the array of connected target endpoints. |
| `create_nodes(nodes)` | Each entry is `{ type, position?, data? }`. `type` must be a registered typeId. |
| `update_nodes(updates)` | Shallow-merge per node; included keys overwrite. `position` is optional. |
| `delete_nodes(nodeIds)` | Removes the nodes and every edge touching them. |

### Edges

Endpoints are encoded as `"node-id/handle-id"`. The handle suffix is
optional only when there's a single handle on that role.

| Tool | Notes |
| --- | --- |
| `list_edges` | Returns the raw edge array with `source`, `target`, handles. |
| `connect_nodes(edges)` | Server-side `isValidConnection`-equivalent check: `contextType` must match between source/target handles. |
| `disconnect_nodes(edges)` | Removes edges by endpoint pair. |

### Focus and comments

These are presentation-layer tools: they emit SSE events but don't change
the persisted graph.

| Tool | Notes |
| --- | --- |
| `focus_node(nodeId, comment?)` | Switches the open canvas to whichever space contains the node, animates the camera, optionally attaches a transient comment bubble. |
| `comment_nodes(comments)` | One comment per node; subsequent calls replace. |
| `uncomment_nodes(nodeIds)` | Drops any attached comments. |

### Local extensions

Operate on `data/extensions/local/<slug>/`. Built-in extensions are
read-only via MCP.

| Tool | Notes |
| --- | --- |
| `list_extensions` | Returns every local extension with manifest + full file map. |
| `get_extension(extensionId)` | One extension. ID must be `local/<slug>`. |
| `create_extension(files)` | Refuses if the folder exists. Manifest's `id` must match the slug. |
| `update_extension(extensionId, files)` | Writes every file in the map; existing files not in the map are preserved. |
| `delete_extension(extensionId)` | `rm -rf` on the folder. |
| `compile_extension(extensionId)` | Returns `BuildResult` from esbuild. Useful when files were written outside the normal flow. |

### Docs

The doc tools operate on `app/docs/` (this folder). Used by the in-app
markdown viewer at `/docs`.

| Tool | Notes |
| --- | --- |
| `doc_search(pattern, maxResults?)` | Regex (case-insensitive) across every `.md` file. |
| `doc_read(path)` | Reads one doc by path relative to the docs root. |
| `doc_edit(path, oldString, newString, replaceAll?)` | Exact-string edit. Fails when `oldString` is non-unique unless `replaceAll`. |
| `doc_write(path, content)` | Create/overwrite. Creates parent dirs. |
| `doc_reply(docPath, commentId, message, author?)` | Posts to a doc-anchored comment thread (used by Erin-style review flows). |

### Remote filesystem and exec

The "target" is a `terminal-context` source handle, encoded as
`"<nodeId>/<handleId>"`. The MCP layer resolves the underlying connection
(local, WSL or SSH) by calling the source extension's `exposeOutput`, then
delegates to `terminal.exec` / `terminal.run` actions exported by the core
extension.

| Tool | Notes |
| --- | --- |
| `remote_read(target, path)` | Reads a UTF-8 file. |
| `remote_write(target, path, content)` | Overwrites the file. |
| `remote_edit(target, path, oldString, newString, replaceAll?)` | Same semantics as `doc_edit`, but on the remote target. |
| `remote_exec(target, command, secrets?, description?)` | Runs `command` in the connected shell. `secrets[]` lists keys to decrypt from any Secrets Store and inject as env vars. Values are never returned; the agent sees stdout/stderr only. |

`remote_exec` is the workhorse: it's how MCP agents check container
status, inspect logs, edit configs, etc.

### UI feedback

| Tool | Notes |
| --- | --- |
| `send_toast(message, type?)` | Broadcasts a sonner toast to every open tab. `type` ∈ `info`, `success`, `warning`, `error`. |

### Node actions

| Tool | Notes |
| --- | --- |
| `list_actions(nodeId)` | Lists every `NodeAction` declared on the node's manifest entry. |
| `call(nodeId, action, params?)` | Calls `dispatchNodeAction(nodeId, action, params)`. Same code path as clicking the button in the inspector. Errors are written to `node.data.__errors`. |

This pair is the bridge between agent automation and the existing canvas
operations: the agent uses `list_actions` to discover what's possible on a
node, then `call` to do it. There is no separate "MCP-only" surface to keep
in sync.

## Implementation notes

- Every handler is a thin wrapper over an existing server action. There is
  no duplicated business logic. `create_space` calls the same
  `createSpace()` the dropdown calls; `connect_nodes` runs through
  `saveSpaceGraph` so `resolveGraphContexts` re-runs.
- Endpoint parsing (`node-id/handle-id`) lives at the top of `tools.ts`
  (`parseEndpoint`). When a node has a single handle on the relevant role,
  the handle suffix is optional.
- Toast / focus / comment events all funnel through
  `lib/toast-store.ts`, which is the same broadcast bus the UI uses for
  `extensions_updated` etc.
- Auth: there is no built-in auth on `/api/mcp`. Run the dev server only on
  trusted networks, or proxy it behind a reverse proxy with auth.

## Adding an MCP tool

1. Append a definition to `toolDefinitions[]` with a JSON schema for its
   args.
2. Add the handler to the registry below it. The handler receives
   `args: Record<string, unknown>` and must return a `Record<string,
   unknown>` (the MCP layer wraps it in `content[].text`).
3. Reuse existing server actions wherever possible. Every UI flow is a
   server action, and exposing it through MCP is usually a one-line
   wrapper.
