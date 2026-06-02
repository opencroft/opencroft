# Built-in node catalog

Every node type ships in the single built-in extension
[`builtin/core`](../%28extension-runtime%29/_builtin/core/extension.json),
version `1.2.0`. The components live in
[`_builtin/core/src/nodes/`](../%28extension-runtime%29/_builtin/core/src/nodes/),
the server-side handlers in
[`_builtin/core/server/`](../%28extension-runtime%29/_builtin/core/server/).

The catalog is grouped by manifest `category`. Each row lists the handles
declared in the manifest and the actions exposed in the inspector.

> **Notation.** `out: terminal-context` means a `source` handle producing
> that context type. `in: docker-context` means a `target` handle consuming
> it. Most consumer handles are also where the inspector reads its inputs.

## Infrastructure

These nodes describe a place where commands run.

| Type | Handles | What it produces |
| --- | --- | --- |
| `localhost` | `out: terminal-context` (`ssh-out`), `out: filesystem-target` (`fs-out`) | `{ type: 'local' }`. Runs commands directly on the Next.js process. |
| `wsl` | `out: terminal-context`, `out: filesystem-target` | `{ type: 'wsl', distro }`. Uses `wsl -d <distro> --exec ...`. Distro is set in the inspector. |
| `server` | `out: terminal-context`, `out: filesystem-target` | `{ type: 'ssh', host, port, username, password?, keyPath? }`. Uses the `ssh2` library. SSH keys come from a connected Key Store; secrets come from a connected Secrets Store. |
| `docker` | `in: terminal-context` (`ctx-in`, host shell), `in: terminal-context` (`context-in`, only used to pick a context), `out: docker-context` (`docker-out`) | Chains its `ctx-in` upstream and adds `contextName`. The `terminal-context` it receives becomes the host where `docker` CLI is invoked. |

The reason `localhost`, `wsl` and `server` look identical from the graph
side is intentional: they all produce the same context shape, so anything
downstream (terminals, scripts, Docker) treats them uniformly.

## Storage

| Type | Purpose | Backed by |
| --- | --- | --- |
| `core-key-store` | Manages SSH private keys. UI lets you generate new keys, import existing ones, copy them to WSL `~/.ssh/keys/`. | Files under `<cacheDir>/extensions/builtin/core/key-store/<storeId>/`. |
| `core-secrets-store` | Encrypted key/value pairs. Each row has a `storeId` matching the node's id. | The `Secret` table in SQLite, encrypted by `host.crypto.encrypt` (AES-GCM in [server/crypto.ts](../../server/crypto.ts)). |

Neither has graph handles; they're consumed by reading the node directly
(e.g. an `application` reads `data.secrets` listing keys to look up across
all stores).

## Windows

Container nodes that frame an embedded UI on the canvas. They have
default size `800x480`.

| Type | Handles | What it does |
| --- | --- | --- |
| `terminal` | `in: terminal-context` (`ssh-in`) | Embeds an xterm.js view connected to the WebSocket terminal server. Re-connects when its input context changes. |
| `file-manager` | `in: filesystem-target` (`fs-in`) | Embeds the [file browser](filemanager.md). Mounts a `FileManagerProvider` scoped to the connected target. |

## Scripts

Editable script bodies with a single `Run` action.

| Type | Handles | Run target |
| --- | --- | --- |
| `script-bash` | `in: terminal-context` (`ctx-in`) | Runs the body via `bash` in the connected target (or `local` if not connected). |
| `script-python` | `in: terminal-context` (`ctx-in`), `in: execution-context` (`exec-in`) | Same, but executed by `python`. The `execution-context` lets an `api-route` or `event` node trigger this script as a handler. |
| `script-node` | `in: terminal-context` (`ctx-in`), `in: execution-context` (`exec-in`) | Same, but executed by `node`. |

The `run` action is implemented by `scriptRun`
([_builtin/core/server/node-actions.ts:221](../%28extension-runtime%29/_builtin/core/server/node-actions.ts#L221))
which dispatches to `runScript({ script, language, context })`.

## Applications

Compose-style services backed by `docker compose`.

| Type | Handles | Actions | Notes |
| --- | --- | --- | --- |
| `application` | `in: docker-context` (`docker-in`), `in: volume-mount` (`volumes-in`) | `start`, `stop`, `restart` | Maps every inspector field to a compose-service entry; takes secrets from a connected Secrets Store; reads networks from any `network` node it sits inside (via `containingNodes('network')`). The whole compose project is per-node: `service:` is the node id. |
| `volume` | `out: volume-mount` (`vol-out`) | (none) | Emits `{ hostPath, containerPath, readOnly }`. Multiple volumes can fan in to one application. |
| `network` | (none) | (none) | Visual frame. Applications inside its bounds join the network at compose time. |

The application start path is rich enough to be its own document; see
`applicationStart` in
[_builtin/core/server/node-actions.ts:155](../%28extension-runtime%29/_builtin/core/server/node-actions.ts#L155).

## Integration

| Type | Handles | Actions | Behaviour |
| --- | --- | --- | --- |
| `api-route` | `out: execution-context` (`exec-out`) | (none) | Registers an HTTP route under `/api/route/<path>`. When called, fires the connected handler script. |
| `event` | `out: execution-context` (`exec-out`) | `run` | Fires the connected handler. The inspector lets you pick a cron schedule (handled by [server/scheduler/event-scheduler.ts](../../server/scheduler/event-scheduler.ts)) or a webhook URL, or trigger manually. |

The handler side reads its trigger via the `execution-context` resolver,
which carries `{ url, method, body, headers, ... }` for routes and `{
trigger: 'cron' | 'manual', payload }` for events.

## Organization

Pure-visual frames; they participate in the graph only through
`containingNodes`.

| Type | Default size | Use |
| --- | --- | --- |
| `section` | 400x300 | Group related nodes; the `Application` node uses `containingNodes('network')` to pick networks the same way. Custom code can read the parent section's `data.label` to namespace logs. |
| `domain` | 400x300 | Same as `section` but uses a globe icon. Convention for "logical environment" (prod, staging). |

Both render with `zIndex: -1` so they sit behind the nodes inside.

## Voice / OpenAI nodes

These are present in `src/nodes/` (`asr-node.tsx`, `microphone.tsx`,
`speaker.tsx`, `openai-chat.tsx`, `openai-audio.tsx`,
`text-to-speech.tsx`, etc.) but **not** registered in
`extension.json`. They're internal helpers used by other nodes' inspectors,
or staged for a future release. Treat them as implementation detail until
they appear in the manifest.

## Adding a new built-in node

1. Append a `NodeMetadata` entry to
   [`_builtin/core/extension.json`](../%28extension-runtime%29/_builtin/core/extension.json).
2. Create `_builtin/core/src/nodes/<typeId>.tsx` with the React component
   and any inspector tabs.
3. Register it in `_builtin/core/src/client.tsx` (the file that calls
   `defineExtension`).
4. If the node has actions or produces a context, add the matching code to
   `_builtin/core/server/node-actions.ts` and `_builtin/core/server/index.ts`.
5. Restart the dev server (or let `scripts/watch-extensions.ts` rebuild).
   Built-in extensions live inside the Next.js source tree, so a normal
   Turbopack reload picks them up.
