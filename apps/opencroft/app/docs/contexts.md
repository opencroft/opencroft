# Typed contexts

Edges in OpenCroft aren't connections-of-anything. Every edge is **typed**:
the source handle and the target handle both declare a `contextType`, and
the React Flow connection validator only allows a wire if the types match.

The point of the type system is two-fold:

- **The user gets meaningful palette suggestions.** Pulling from a
  `terminal-context` source pre-filters the new-node menu to only the nodes
  that consume that type.
- **Server-side resolution is automatic.** Whenever a graph saves, the
  server walks every edge and writes a structured value (an SSH config, a
  filesystem target, a Docker context name, etc.) into the consumer's data,
  so node actions and React renders can read inputs without round-tripping
  through the source node.

## Built-in context types

Defined in
[_builtin/core/extension.json](../%28extension-runtime%29/_builtin/core/extension.json):

| ID | Color | Carries |
| --- | --- | --- |
| `terminal-context` | violet | A terminal target: `{ type: 'local' }`, `{ type: 'wsl', distro }`, or `{ type: 'ssh', host, port, username, password?, keyPath? }`. Optional `contextName` adds a Docker context on top. |
| `filesystem-target` | green | The filesystem side of a terminal target. Same shape as `terminal-context`. |
| `execution-context` | orange | Async request/response handler used by `api-route` and `event` nodes that can fire connected scripts. |
| `docker-context` | blue | A Docker daemon target: a `terminal-context` plus `contextName` (string). |
| `volume-mount` | amber | `{ hostPath, containerPath, readOnly }` for compose-style mounts. |

`color` is an OKLCH string used to paint the handle pin and the wire. The
`label` is the inspector tooltip.

Adding a new context type means appending to `contexts[]` in your
extension's manifest. The registry merges all extensions' context maps; type
names must be globally unique.

## Declaring a handle

Handles live on `NodeMetadata`:

```json
{
  "typeId": "server",
  "handles": [
    { "id": "ssh-out", "contextType": "terminal-context", "role": "source", "label": "Terminal" },
    { "id": "fs-out",  "contextType": "filesystem-target", "role": "source", "label": "Files"    }
  ]
}
```

`role: 'source'` produces; `role: 'target'` consumes. The validator
([flow-editor.tsx](../%28dashboard%29/_canvas/flow-editor.tsx)
`isValidConnection`) requires both types to match _and_ the source-to-target
direction.

## Producing a value: `exposeOutput`

There are two `exposeOutput`s, and both are valid simultaneously:

- **Server-side**, exported from `server/index.ts`. This is what the graph
  resolver uses on save. It runs in Node.js and can read files, query the
  DB, etc.
- **Client-side**, declared on the `NodeDefinition` passed to
  `defineExtension`. This is used at React render time when a downstream
  node wants to pull a value reactively in the browser. Most extensions can
  ignore it; the registry only calls it from `useNodeContext`.

Signature:

```ts
function exposeOutput(
  handleId: string,
  nodeData: Record<string, unknown>,
  typeId: string,
  nodeId: string,    // server-side only
): unknown;
```

Return whatever the consumer expects. Return `undefined` to skip: the
resolver won't write the entry, and the consumer's `input(handleId)` returns
`undefined`.

The built-in core extension is the canonical reference. From
[`server/index.ts`](../%28extension-runtime%29/_builtin/core/server/index.ts):

```ts
if (typeId === 'wsl') {
  if (handleId === 'ssh-out' || handleId === 'fs-out') {
    return { type: 'wsl', distro: nodeData.distro };
  }
}

if (typeId === 'docker') {
  // Docker chains on top of an upstream terminal context (the host it talks to).
  const upstream = nodeData.__resolvedContexts?.['ctx-in']?.value ?? { type: 'local' };
  return { ...upstream, contextName: nodeData.contextName ?? '' };
}
```

Notice the second example: a node's `exposeOutput` can read its own
`__resolvedContexts` to chain. Because the resolver iterates edges in
declaration order and each call freshly reads the in-progress graph, a
multi-hop chain (Server → Docker → Application) works as long as the edges
were saved in topological order, which the canvas does naturally.

## Consuming a value

### From a server `nodeAction`

```ts
export const nodeActions = {
  'application': {
    async start(ctx) {
      const docker = ctx.input<DockerContext>('docker-in');
      const volumes = ctx.connectedSources('volumes-in')
        .map((s) => s.data as VolumeMount);
      // ... call docker.up
    },
  },
};
```

The helpers come from `NodeActionCtx`
([_types.ts](../%28extension-runtime%29/_types.ts)):

| Helper | Returns |
| --- | --- |
| `input<T>(handleId)` | The resolved value, or `undefined` if no connection or `exposeOutput` returned `undefined`. |
| `inputSource<T>(handleId)` | `{ sourceNodeId, sourceHandleId, contextType, value }`. Useful when you need to know *who* you connected to. |
| `connectedSources(handleId)` | All connected sources, raw: `{ nodeId, handleId, type, data }[]`. Useful for many-to-one fan-in (e.g. multiple volumes mounted). |
| `containingNodes(typeId?)` | Nodes whose bounding box contains this node. The parent `Section` or `Domain` frame this node sits inside. Useful for grouping logic. |

### From a React component

```tsx
import { useNodeContext } from '@ext/host';

function ApplicationCard({ id, data }) {
  const docker = useNodeContext<DockerContext>(id, 'docker-in');
  // ...
}
```

`useNodeContext` reads `data.__resolvedContexts[handleId]?.value`. It's
purely a convenience: the data is on the node object itself.

## The resolver

[graph-context-resolver.ts](../%28extension-runtime%29/_server/graph-context-resolver.ts)
runs every time `saveSpaceGraph` is called. The flow:

1. Load every extension manifest. Build `typeId → { extensionId, handleId →
   contextType }` maps.
2. Strip the `__resolvedContexts` blob from every node so we start fresh.
3. For each edge with `source`, `sourceHandle`, `target`, `targetHandle`:
   - Find the source node and look up the context type for its handle.
   - Activate the source extension's server module if needed.
   - Call its `exposeOutput(handleId, sourceData, typeId, sourceId)`.
   - Write `{ sourceNodeId, sourceHandleId, contextType, value }` into
     `targetNode.data.__resolvedContexts[targetHandleId]`.
4. Return the mutated graph snapshot.

The resolver swallows per-edge errors with a `console.error` so a single
broken extension doesn't poison the whole save. Errors during a node action
land on `node.data.__errors` instead, where the inspector picks them up.

## Why both client- and server-side `exposeOutput`?

Because they answer different questions:

- The **server** resolver pre-bakes everything once per save. That makes
  `nodeAction` calls instant: no extra extension activation needed. It's
  also what lets MCP read a graph and execute a remote command without ever
  rendering the canvas.
- The **client** `exposeOutput` lets a React component derive a value from
  another node's *live* data without re-saving. For most nodes the two
  return the same thing; for stateful UI (e.g. an in-progress form before
  save), the client one might preview values that haven't been persisted
  yet. Built-in nodes don't currently use the client variant; it's there
  for extensions that want to.

## Adding a new context type, checklist

1. Append to `contexts[]` in your `extension.json`. Pick a globally unique
   ID, an OKLCH color and a description.
2. Add `handles[]` to every node that produces or consumes it.
3. In the producing extension's `server/index.ts`, return a value from
   `exposeOutput` for the relevant `(typeId, handleId)` pairs.
4. In the consuming extension, read it via `ctx.input(...)` or
   `useNodeContext(...)`.

That's the whole API. The resolver, palette filtering and connection
validation pick up the new type for free as long as the manifest declares
it.
