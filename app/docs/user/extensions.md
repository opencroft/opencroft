# Extensions

Every node on the canvas comes from an extension. The bundled
[`builtin/core`](../nodes/README.md) ships ~28 nodes. You can install
more, or write your own.

## Where extensions live

- **Built-in:** `app/(extension-runtime)/_builtin/<slug>/`: shipped with
  the app, read-only.
- **Local:** `data/extensions/local/<slug>/`: your stuff. Override the
  path with `OPENCROFT_EXT_ROOT`.

Extension IDs are `<scope>/<slug>` (e.g. `local/my-thing`). The folder
name must match the slug.

## Author your own

Open the canvas. Toggle the editor (button in the top-left). Click
**+ New extension** and pick a slug.

The starter template gives you:

- `extension.json`: manifest with one node entry.
- `src/client.tsx`: React component for the node.
- `server/index.ts`: server-side actions for the node.

Edit any file in the editor. Saves auto-rebuild via esbuild. The canvas
hot-reloads: your node updates without losing graph state.

## A minimal extension

`extension.json`:

```json
{
  "id": "local/coin-flip",
  "name": "Coin Flip",
  "version": "0.0.1",
  "nodes": [
    {
      "typeId": "coin-flip",
      "name": "Coin Flip",
      "category": "Custom",
      "icon": "Coins",
      "actions": [
        { "id": "flip", "label": "Flip", "icon": "Play" }
      ]
    }
  ]
}
```

`src/client.tsx`:

```tsx
import { defineExtension, NodeFrame, icons } from '@ext/host';
import { Badge } from '@ext/ui';

const CoinFlip = ({ data, selected }) => (
  <NodeFrame icon={icons.Coins} title='Coin Flip' selected={!!selected}>
    <Badge>{data.last ?? 'never flipped'}</Badge>
  </NodeFrame>
);

export default defineExtension({
  manifest: { id: 'local/coin-flip' },
  nodes: [{
    typeId: 'coin-flip',
    name: 'Coin Flip',
    icon: 'Coins',
    component: CoinFlip,
    defaultData: { last: null },
  }],
});
```

`server/index.ts`:

```ts
import host from '@ext/host';

export const nodeActions = {
  'coin-flip': {
    async flip(ctx) {
      const result = Math.random() < 0.5 ? 'heads' : 'tails';
      await host.graph.updateNode(ctx.nodeId, { data: { last: result } });
      return result;
    },
  },
};
```

Save. Drag your new node from the palette. Click **Flip**. The badge
updates.

## What you can register

- **Nodes**: types of canvas tile.
- **Contexts**: new typed handles other extensions can produce or
  consume.
- **Command modes**: entries in the canvas command bar.
- **Settings pages**: pages under `/settings`.

## Hot reload

`npm run dev:ext` watches `data/extensions/local/`. Any save triggers a
rebuild. The canvas listens for the rebuild SSE event and re-loads
bundles in place. Existing nodes keep their state.

If a build fails, OpenCroft toasts the error and keeps running the
previous bundle: you don't lose your canvas.

## Invoke server actions from the client

```tsx
import { callAction } from '@ext/host';
const result = await callAction('local/coin-flip', 'flip', []);
```

Or call a node-level action with `callNodeAction(nodeId, actionId,
params?)`.

## Use the host APIs

In the server module, `host` gives you:

- `host.fs`, `host.os`, `host.path`: Node built-ins.
- `host.exec(cmd)` / `host.execFile(cmd, args)`: run shell commands.
- `host.prisma`: the same Prisma client the app uses.
- `host.crypto.encrypt` / `host.crypto.decrypt`: same key the Secrets
  Store uses.
- `host.cacheDir(...parts)`: per-extension cache folder.
- `host.settings.get` / `host.settings.set`: JSON settings storage.
- `host.graph.*`: read and mutate any node in any space.
- `host.storage.*`: namespaced key/value storage for the extension.

## Sharing

There's no online registry yet. To share an extension, zip up the folder
under `data/extensions/local/<slug>/` and hand it to whoever wants it.
They drop it into the same path on their machine.

## Delete

In the editor, hover the extension name and click the trash icon. The
folder is removed. Nodes already on the canvas show as "Unknown
extension" until you reload.
