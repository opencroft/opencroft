# Spaces and the graph

A **space** is the smallest unit of work in OpenCroft: one canvas, one graph,
one row in the `Space` table. Multiple spaces let a user keep separate
diagrams (e.g. `homelab`, `work-vps`, `playground`) and switch between them
without losing layout.

## The data model

Defined in [prisma/schema.prisma](../../prisma/schema.prisma):

```prisma
model Space {
  id        String   @id @default(cuid())
  slug      String   @unique
  name      String
  data      String   @default("{\"nodes\":[],\"edges\":[]}")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

`data` is a JSON-encoded `GraphData`:

```ts
// app/(space)/server/types.ts
interface GraphData {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
}
```

The keep-it-simple choice. The shapes inside are React Flow's `Node` and
`Edge` types (`@xyflow/react`), augmented with two synthetic data keys:

- `__resolvedContexts`: written by the server-side context resolver. One
  entry per consumed handle.
- `__errors`: string array set when a `nodeAction` throws. Cleared on the
  next successful action.

There are no separate tables for nodes or edges. The whole graph is rewritten
on every save. This is fast enough for the homelab-scale graphs the project
targets and trivial to roll back.

## The registry

`SpacesRegistry` ([app/(space)/server/store.ts:30](../%28space%29/server/store.ts#L30))
is a global singleton (kept on `globalThis.__SPACES_REGISTRY__` so Next.js
hot-reload doesn't lose state). Behaviour:

- **Lazy load.** First call to `ensureLoaded()` reads every row from
  `prisma.space`, parses each JSON blob and caches the result.
- **Legacy migration.** If no spaces exist but a `Setting` row with id
  `app-dashboard-mvp-graph` does, the registry reads that blob into a new
  default space (`slug: 'default'`, `name: 'Default'`).
- **Default seed.** If the table is empty after migration, a single default
  space is created.
- **Active-space tracking.** `getActiveSlug()` / `setActiveSlug()` read and
  write the `Setting` row with id `active-space-slug`. If no active slug is
  set or it points to a deleted space, the first space is used.
- **Find by node.** `findByNode(nodeId)` walks every cached graph; used by
  MCP `focus_node` and by the host's `updateNode`/`deleteNode` to locate the
  owning space.

## Server actions

All space mutations go through [app/(space)/server/actions.ts](../%28space%29/server/actions.ts):

| Action | Behaviour |
| --- | --- |
| `listSpaces()` | Returns every `SpaceSummary` (no graph data). |
| `loadSpaceGraph(slug)` | Returns the cached `GraphData` for a slug. |
| `saveSpaceGraph(slug, data)` | Runs `resolveGraphContexts` first, then writes to SQLite. |
| `createSpace(name)` | Slugifies the name, picks a unique slug, persists an empty graph. |
| `renameSpace(slug, name)` | Updates the row; slug is immutable. |
| `deleteSpace(slug)` | Refuses to delete the last `default` space. |
| `exportSpace(slug)` | Returns `{ name, slug, graph, exportedAt }`. |
| `importSpace(payload)` | Re-slugifies and creates a new space from an export. |
| `getActiveSpaceSlug()` / `setActiveSpaceSlug(slug)` | Active-space pointer. |
| `findSpaceByNode(nodeId)` | Used by MCP to focus a node in any space. |

`saveSpaceGraph` is the only one that calls `resolveGraphContexts`. The
client never sees the resolved contexts in the round trip back, but they are
visible to the next read because the resolved blob is what got persisted.

## The canvas

Mount path: `app/(space)/space/[slug]/page.tsx` to `<SpaceCanvas>` to
`<FlowEditor slug={...} />`.

`FlowEditor` ([flow-editor.tsx](../%28dashboard%29/_canvas/flow-editor.tsx))
does the work:

1. On mount, `loadAllExtensions()` fetches every compiled client bundle and
   registers it with `extensionRegistry`. Then `fetchSpaceGraph(slug)` pulls
   the graph and seeds React Flow state.
2. Every change to nodes or edges fires `useDebouncedSave` (500 ms).
   `stripVirtualNodes` removes ephemeral comment nodes before sending.
3. `buildNodeTypes(extensionRegistry.allNodes())` is fed to React Flow's
   `nodeTypes` map. The wrapper component renders `<NodeFrame>` then
   `<NodeCard>` and forwards the typed props the extension declared.
4. `useGraphEvents` translates SSE events into canvas behaviour: rebuilt
   extensions trigger `loadAllExtensions` again, focus events center the
   camera on the targeted node, comment events add a `comment` virtual
   node.
5. `useClipboard` handles copy/paste of selected nodes (UUIDs are
   regenerated on paste).

### Inspector and palette

- `NodePalette` (left sidebar): groups every registered node by `category`,
  draggable into the canvas. Drop creates a node with the extension's
  `defaultData` and a category-aware default size (Organization frames are
  400x300 with `zIndex: -1`; Windows nodes are 800x480; everything else is
  React Flow's default).
- `NodeInspector` (right sidebar, resizable): shows the selected node's
  `defaultData` fields plus any `inspectorTabs` declared by the extension,
  plus an "Actions" section that lists the manifest's `actions[]` and calls
  `dispatchNodeAction(nodeId, actionId)` when clicked.

### Connection rules

`isValidConnection` (in `flow-editor.tsx`) only allows an edge if:

- both endpoints declare a `contextType`,
- their context types match, and
- the source role is `source` and the target role is `target`.

Connecting from an empty patch of canvas opens `FlowContextMenu` filtered to
node types that declare a matching handle, so a half-drawn wire never lands
on incompatible candidates.

### Comments

Right-clicking a node and choosing "Comment" injects a transient `comment`
node above it. Comments are not persisted in `GraphData`; they live only in
React Flow state. The MCP `comment_nodes` tool broadcasts an SSE event
that adds the same kind of comment in every open tab.

## Reading the graph from server code

The host
([_server/host.ts](../%28extension-runtime%29/_server/host.ts)) gives every
extension a `host.graph` API that flattens every space into a single
`GraphSnapshot` so a node action can talk to siblings even if they live in a
different space:

```ts
host.graph.listNodes()
host.graph.getNode(nodeId)
host.graph.listNodesByType(typeId)
host.graph.listEdges()
host.graph.updateNode(nodeId, patch)   // writes back to the owning space
host.graph.createNode(typeId, data, position)  // creates in the active space
host.graph.deleteNode(nodeId)          // removes the node and any edges
```

Internally these helpers use `SpacesRegistry` to find the right space and
call `r.saveGraph(slug, graph)`.

## Active-space switching

`SpaceSwitcher` (in `app/(space)/space/_components/space-switcher.tsx`) is the
dropdown in the canvas header. Switching writes
`active-space-slug` and routes the browser to `/space/<slug>`. The dashboard
landing page (`app/(dashboard)/page.tsx`) reads the active slug and redirects
to the matching space, so opening `/` always goes to the last space the user
worked on.
