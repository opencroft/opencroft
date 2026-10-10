# Authoring extensions

An extension adds to OpenCroft at runtime: node types for the canvas, Apps a
person adds to a space, command-bar modes, settings pages, panels and chat
controls, HTTP routes and MCP tools. This guide is how to write one. The API
itself is declared in two packages of this repository, `@opencroft/client` and
`@opencroft/server`. Every member is documented where it is declared, and
this guide is the map to those declarations.

> The extension API is experimental and may change between versions.

## The parts of an extension

An extension is a folder, usually its own git repository:

```
extension.json       the manifest: what the extension is and what it declares
src/client.tsx       the client half: React components, run in the browser
server/index.ts      the server half: actions, routes, tools, App hooks
assets/              static files, served as they are (`assetUrl(path)`)
package.json         the extension's own dependencies, if it has any
```

Only `extension.json` is required. The client entry is the first of
`src/client.tsx`, `src/client.ts`, `src/index.tsx`, `src/index.ts` that exists;
the server entry the first of `server/index.ts`, `server/index.tsx`,
`extension.ts`, `extension.tsx`.

An instance keeps each extension in a folder of its data directory's
`extensions`, and the extension runs under that folder's name: `local.<name>`
for one created or developed on the instance, `<owner>.<extension>` for an
installed one. Code never hard-codes its id. It reads `extensionId` from the
`extension` module of either package.

The host builds the two halves itself with esbuild, into `dist/client.js` and
`dist/server.js`, when the extension is first used after its sources changed,
or on request (`compile_extension` over MCP, or the Extensions page). A build
reports its errors and warnings with file and line, including every use of a
deprecated API.

### Two declarations, read at different times

The server reads `extension.json` before any bundle is loaded, so everything
the host lists without running the extension is declared there: node types for
the palette, Apps for the add-App dialog, MCP tools, the actions agents call.
The client bundle's `defineExtension` declares the same nodes and Apps again,
with the React components a manifest cannot hold. The two are matched by the
same bare type and must agree. A field the host reads from the manifest (an
App's `fullPageRoutes`, a node action's input schema) has no effect when given
only in the client.

## The manifest

```json
{
  "name": "Widgets",
  "version": "1.0.0",
  "description": "Gauges and dials",
  "handleTypes": [{ "id": "reading", "label": "Reading", "color": "oklch(0.7 0.15 150)" }],
  "nodes": [
    {
      "type": "gauge",
      "name": "Gauge",
      "category": "Widgets",
      "icon": "Gauge",
      "handles": [{ "id": "in", "handleType": "reading", "role": "target" }],
      "actions": [{ "id": "reset", "label": "Reset", "description": "Zero the gauge" }]
    }
  ],
  "provides": {
    "apps": [{ "type": "dashboard", "title": "Dashboard", "icon": "LayoutDashboard" }],
    "mcpTools": [{ "name": "widgets_read", "description": "Read every gauge" }]
  }
}
```

- The manifest needs no `id`: the extension runs under its folder's name.
- **Types are declared bare** (`gauge`, `reading`, `dashboard`) and the host
  qualifies them with the extension's id: the node type above is stored in
  graphs as `<extension id>.gauge`. Another extension's type is written
  qualified, and core's as `builtin.core.<type>` (for example
  `builtin.core.terminal-context`, `builtin.core.text-stream`,
  `builtin.core.execution-context`).
- `icon` is a Lucide icon name.
- `nodes[].actions` lists each node action: `id`, `label`, `description`,
  `icon`, `inputSchema` (JSON Schema, shown to agents by `list_actions`) and
  `execution` (`sync`, `awaitable` or `async`; see `ExecutionMode` in
  `@opencroft/core`). The handler is in the server module's `nodeActions`.
- A target handle may name a node action as `streamAction` (run when a text
  stream into the handle completes, with `{ text }` as its parameters) or
  `streamChunkAction` (run on every chunk, with the chunk as its parameters).
- `provides.apps` entries are `AppEntry` (`@opencroft/core`): `type`, `title`,
  `description`, `icon`, the `parameters` asked for when a person adds the App,
  `actions` (`AppActionMeta`: what agents call with `app_call`), `handles`
  (context sources each instance exposes) and `fullPageRoutes`.
- `provides.mcpTools` entries are `McpToolMeta` (`@opencroft/server/tools`).
- `extensionDependencies` lists the ids of extensions to activate first.
- `clientStubs` lists bare specifiers the client build resolves to an empty
  module: for a dependency's optional branch the extension never reaches.

The deprecated keys `typeId` (node), `slug` (App), `contexts` and
`contextType` are still read where `type`, `handleTypes` and `handleType` are
absent, and every build warns about them.

## The client half

The client module's default export is its declaration:

```tsx
import { type ExtensionComponentProps, InputHandle, NodeFrame } from '@opencroft/client/canvas'
import { defineExtension } from '@opencroft/client/extension'
import { Gauge } from 'lucide-react'

interface GaugeData {
  title?: string
  value?: number
}

function GaugeNode({ data, selected }: ExtensionComponentProps<GaugeData>) {
  return (
    <NodeFrame icon={Gauge} title={data.title ?? 'Gauge'} selected={selected ?? false}>
      <InputHandle type='reading'>in</InputHandle>
      <span className='text-xs'>{data.value ?? 0}</span>
    </NodeFrame>
  )
}

export default defineExtension({
  manifest: { name: 'Widgets' },
  handleTypes: [{ id: 'reading', label: 'Reading', color: 'oklch(0.7 0.15 150)' }],
  nodes: [
    {
      type: 'gauge',
      name: 'Gauge',
      category: 'Widgets',
      icon: 'Gauge',
      handles: [{ id: 'in', handleType: 'reading', role: 'target' }],
      defaultData: { title: 'Gauge', value: 0 },
      component: GaugeNode,
    },
  ],
})
```

`ExtensionDeclaration` (`@opencroft/client/extension`) is everything it takes:

| Key | What it declares | Declared as |
| --- | --- | --- |
| `nodes` | node types: `component`, `inspector` or `inspectorTabs`, `contextMenuItems`, `exposeOutput`, `defaultData`, `handles` | `NodeDefinition` in `canvas` |
| `handleTypes` | the handle types the extension's handles carry | `ExtensionHandleType` in `canvas` |
| `commandModes` | modes of the command bar, opened by their shortcut or `useOverlay().activate(id, params)` | `CommandModeDefinition` in `canvas` |
| `settings` | pages in Settings, under the extension's name | `SettingsPageDefinition` in `extension` |
| `provides` | entries for the host's provider points (below) | `ProvidedPoints` in `extension` |

`defineExtension` throws when the declaration declares nothing.

### Nodes

- `component` draws the node with `ExtensionComponentProps<D>` (`id`, `data`,
  `selected`). Build it from `NodeFrame` (or `NodeCard`, `NodeCardHeader`,
  `NodeCardContent`) and the pins `InputHandle` and `OutputHandle`, so it looks
  and connects like every other node.
- `inspector` is the node's panel in the inspector; `inspectorTabs` splits it
  into tabs. Both get `ExtensionInspectorProps<D>`: `nodeId`, `data` and
  `updateData(patch)`.
- `useNodeContext(nodeId, handleId)` reads what is wired into a target handle
  on the open canvas. A node offers a value on its source handle with
  `exposeOutput(handleId, data, type, nodeId, contexts)`.
- Graph data stores the qualified type; every callback the host hands the
  extension (`exposeOutput`, a context-menu item's `type`, a node action's
  `ctx.type`) gets the bare one.

### Provider points

A provider point is a place in the host that extensions add to. Declaring an
entry under `provides` is all it takes, and the browser loads an extension's
client bundle only on the surfaces whose points it provides.

| Point | Entry | Shown |
| --- | --- | --- |
| `apps` | `AppDefinition` (`app`) | as an App; also declared in the manifest |
| `markdownResolvers` | `MarkdownResolver` (`markdown`) | as chips in every `Markdown` and `MarkdownEditor`; in rendered markdown a press follows the reference's `href`, calls its `open`, or shows its `popover` content |
| `right-sidebar-panels` | `RightSidebarPanel` (`extension`) | as a tab of the shell's right sidebar |
| `agent-chat-input-controls` | `AgentChatInputControl` (`chat`) | beside the agent chat's composer |
| `agent-chat-status-indicators` | `AgentChatStatusIndicator` (`chat`) | at the foot of the agent chat's messages |

`provides` is typed for these points. Any other key is accepted, and the host
keeps its entries for whatever code reads that point.

### Apps

An App is a full-page tool a person adds to a space, as often as they like,
each instance with its own parameters and data directory. It has up to three
parts:

1. its `provides.apps` entry in `extension.json` (`AppEntry`);
2. its client half under `provides.apps` in `defineExtension` (`AppDefinition`:
   the entry plus `component`, and an optional parameter `form`);
3. its server half under `apps` in the server module (`AppServerHooks` in
   `@opencroft/server/apps`): lifecycle hooks, the actions agents call with
   `app_call`, and the live ids of dynamic handles.

The component gets `AppComponentProps` (`instanceId`, `spaceSlug`, `params`).
The `app` module has the App's routing (`useAppLocation`, `AppLink`,
`useAppNavigate`) and its places in the host's chrome (`AppTitle`,
`AppActions`, `AppToolbar`, `AppSidebar`). The App's own UI runs its actions
with `callAppAction(instanceId, action, params)`, as the signed-in person.

## The server half

The server module exports what the host calls. Every export is optional.

```ts
import type { NodeActionContext, NodeActions } from '@opencroft/server/actions'
import type { ExtensionRoutes } from '@opencroft/server/routes'
import { storage } from '@opencroft/server/storage'

interface GaugeData {
  value?: number
}

export const nodeActions = {
  gauge: {
    reset: async (ctx: NodeActionContext<GaugeData>) => {
      ctx.updateData({ value: 0 })
      return 'reset'
    },
  },
} satisfies NodeActions

export const actions = {
  readAll: async () => (await storage.get<number[]>('readings')) ?? [],
}

export const routes: ExtensionRoutes = {
  health: () => new Response('ok'),
}
```

| Export | What it is | Declared as |
| --- | --- | --- |
| `actions` | the extension's own actions, run from its client with `invoke(name, ...args)` | `ExtensionActions` in `actions` |
| `actionAccess` | `admin` for each action only admins may run from the browser | `ActionAccessMap` in `actions` |
| `nodeActions` | node actions by bare node type, then action id; each gets a `NodeActionContext` | `NodeActions` in `actions` |
| `nodeActionAccess` | the same policy for node actions | `NodeActionAccessMap` in `actions` |
| `exposeOutput` | the value a node's source handle carries, for server-side readers of the graph | `ExposeOutput` in `actions` |
| `routes` | HTTP handlers at `/api/ext/<extension id>/http/<path>` (`routeUrl(path)`) | `ExtensionRoutes` in `routes` |
| `tools` | the handlers of the manifest's `provides.mcpTools`, by name | `ExtensionToolHandler` in `tools` |
| `apps` | each App's server hooks and actions, by bare App type | `AppsExport` in `apps` |
| `load`, `unload` | run when the extension is activated and torn down | `Load`, `Unload` in `lifecycle` |

A node action runs from the node's UI (`dispatch(nodeId, actionId, params)` in
the client), from an agent (the MCP `call` tool) or from the graph. Its
context holds the node's `data` and the call's `params`, the values wired into
its handles (`input`, `inputSource`, `connectedSources`), its output streams
(`output(handleId)`), `updateData`, the calling agent when there is one, and
an abort `signal` when the run can be cancelled.

- **A node fed by an execution context** (an API route or an Event node)
  declares a target handle `{ "id": "exec-in", "handleType":
  "builtin.core.execution-context", "role": "target" }` and a node action named
  `handle`. It receives the request event as `ctx.params` (`{ method, path,
  params, query, headers, body }`), and the `{ status, body }` it returns is the
  HTTP answer when the node is the primary target.
- **To feed Log and send-message nodes**, declare a source handle of type
  `builtin.core.text-stream` and broadcast `{ text, final }` on it; on
  `final: true` the accumulated text is delivered downstream.
- **Access:** `actionAccess` and `nodeActionAccess` guard the browser's entry
  points only. An agent's `call` and a graph run reach node actions without
  them.
- **Routes** are public unless declared `{ session: 'person', handler }`, which
  only a signed-in person reaches. Bulk bytes go through a route, never
  through an action's result.
- **Secrets:** keep `secret:NAME` references in node data and resolve them
  with `secrets` when they are used. Never put a credential in node data or
  in anything the client receives.

## The host API

Each package is split into modules, each its own import path. Import from the
modules; the package roots re-export them all.

| `@opencroft/client/…` | What it has |
| --- | --- |
| `extension` | `defineExtension` and the declaration types, the provider points, `extensionId`, `urlBase`, `assetUrl`, `routeUrl`, `absoluteUrl` |
| `actions` | `invoke` (own server actions), `dispatch` (node actions), `callAppAction` |
| `storage` | `createStorage`: the extension's key-value store, shared with its server half |
| `canvas` | node definitions and props, handle pins, `NodeFrame` and `NodeCard*`, `useNodeContext`, the inspector intent, context menus, xyflow hooks, command modes, `useOverlay`, `GraphCanvas` |
| `graph` | `NodeRef`, `describeGraphRefs`, `subscribeGraphRefs` |
| `streams` | `getStream`, `subscribe`, `broadcast`; the server's `events` arrive on `getStream(extensionId, 'events')` |
| `chat` | `ChatDock`, `EmbeddedAgentChat`, `ChatSelector`, the selection that rides along with a message, the agent-chat provider points |
| `app` | `AppDefinition` and its props, App routing, the App's places in the chrome, `useUrlParam`, `useIsMobile` |
| `markdown` | `Markdown`, `MarkdownEditor`, `MarkdownDiffView`, `MermaidDiagram`, `MarkdownResolver` |
| `code` | `CodeBlock`, `CodeBlockEditor`, `CodeEditor` |
| `terminal` | `Terminal`, `TerminalSelector`, `TerminalList` |
| `secrets`, `files`, `docker` | `SecretSelector`; `FileBrowser`; the docker container hooks |
| `ui` | every design-kit component (`Button`, `Dialog`, `Select`, …) |

| `@opencroft/server/…` | What it has |
| --- | --- |
| `extension` | `extensionId`, `urlBase`, `assetUrl`, `routeUrl`, `absoluteUrl(request, url?)` |
| `actions` | the types of `actions`, `nodeActions`, their access maps and `exposeOutput`, and the node-action context |
| `system` | `fs`, `os`, `path`, `exec`, `execFile`, `crypto` |
| `storage` | `storage`, `cacheDir`, `dataDir` |
| `settings`, `secrets`, `graph`, `events`, `collab` | the member of that name |
| `apps` | `apps.listInstances` and the App server contract |
| `chat` | `groupChats`, `sendMessage` |
| `people` | `users`, `agents`, `mentions`, `mcpTokens` |
| `terminal` | `terminal`, `ssh`, `execContext` |
| `routes`, `tools`, `lifecycle` | the types of those exports |

`@opencroft/core` holds the contracts both halves share (`AppEntry`,
`ExecutionMode`, …). The packages are declarations: the host injects each
module's runtime when it builds the extension, and a module or name that does
not exist fails the build.

`react`, `react-dom`, `lucide-react` and `sonner` are served by the host too,
so an extension draws with the host's own React, icons and toaster. Don't add
them or `@opencroft/*` to the extension's dependencies. Anything else the
extension imports goes in its `package.json`, and the host installs it before
building. Node built-ins work in server code.

`@ext/host`, `@ext/ui` and the `legacy` namespace of either package are the
deprecated surface: they still work, every build warns about each use, and
each name's `@deprecated` note names the module it moved to.

## Checking an extension

`opencroft-dev` (`packages/dev-tools`) formats, lints and typechecks this
repository and every extension repository. An extension's `package.json`
carries:

```json
"scripts": {
  "fix": "opencroft-dev fix",
  "typecheck": "opencroft-dev typecheck"
}
```

Run them with a core checkout's `node_modules/.bin` on `PATH`. Inside an
instance's extensions folder they are found with no setup.

```
PATH="<core checkout>/node_modules/.bin:$PATH" npm run fix
```

The typecheck checks the extension against the declarations above, so a wrong
prop, a missing field of a provider entry or a misspelt member of a node
action's context fails it before the build. An editor gets the same types for
an extension inside a core checkout, with `"moduleResolution": "bundler"` and
`"jsx": "react-jsx"` in the extension's `tsconfig.json`.

## Where to look next

- `packages/client/src/*.ts` and `packages/server/src/*.ts`: the declarations,
  one file per module.
- `apps/opencroft/app/_authed/(extension-runtime)/_builtin/core`: the builtin
  extension, written against the same API.
- `apps/opencroft/app/_authed/(extension-editor)/_templates/template.ts`: what
  the Extensions page creates for a new extension.
