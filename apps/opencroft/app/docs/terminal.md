# Terminal

A browser-based terminal that supports local shells, WSL distros and remote
SSH targets through a single WebSocket protocol. Rendered with
[`@xterm/xterm`](https://xtermjs.org). The server side runs as a separate
Node process so it can use `@lydell/node-pty` and `ssh2` without dragging
those native deps into the Next.js build.

The terminal **node** on the canvas (`terminal` type) wraps the same
`TerminalView` component used by the standalone `/terminal` page, so
clicking "Run" on a script node and a tab in the terminal page render with
identical code.

## Layout

```
+---------------------------+    JSON over WS (port 3334)    +-----------------------+
| Browser                   | -----------------------------> | websocket/terminal.ts |
|   xterm.js                | <----------------------------- | (standalone process)  |
|   useTerminalWs hook      |                                |                       |
+---------------------------+                                |  ssh: ssh2 Client     |
                                                             |  pty: node-pty spawn  |
                                                             +-----------------------+
```

Two processes run in dev:

- `npm run dev`: Next.js (port 9999).
- `npm run dev:ws`: the terminal WebSocket server (`tsx
  websocket/terminal.ts`, port 3334 by default; override via `WS_PORT`).

In production the terminal server is started the same way (a separate
process). The browser picks the URL automatically:

- `localhost`, RFC1918, or `127.0.0.1` produces `ws://<host>:3334`.
- Anything else produces `ws(s)://<host>/ws-terminal` (proxy this path to
  the terminal server in your reverse proxy).

## Protocol

One WebSocket connection per terminal. All frames are JSON.

### Client to server

| Type | Payload | Effect |
| --- | --- | --- |
| `connect` | `SshConnectionConfig + { cols, rows, command? }` | Open SSH connection and shell. Optional `command` runs that command instead of an interactive shell. |
| `local` | `{ shell?, command?, args?, cols, rows }` | Spawn a local PTY. Defaults to `bash` on Unix, `powershell.exe` on Windows. |
| `wsl` | `{ distro?, command?, args?, cols, rows }` | Spawn `wsl.exe -d <distro> --exec <command> [args]`. |
| `data` | `{ data }` | Stdin (keystrokes/paste). |
| `resize` | `{ cols, rows }` | Resize the PTY/SSH channel. |
| `disconnect` | `{}` | Close the session. |

### Server to client

| Type | Payload |
| --- | --- |
| `connected` | `{ sessionId: 'ssh' \| 'local' \| 'wsl' }` |
| `data` | `{ data }` (stdout/stderr) |
| `error` | `{ message }` |
| `disconnected` | `{ reason }` |

The server keeps a `Map<WebSocket, Session>` ([websocket/terminal.ts:47](../../websocket/terminal.ts#L47))
where each session is either `{ type: 'ssh', shell }` or `{ type: 'pty',
proc }`. Disconnect, exit and `unhandledRejection` all funnel through
`destroySession` so neither SSH channels nor PTY processes leak.

The shell factory:

- **SSH:** [app/(ssh)/server/ssh-client.ts](../%28ssh%29/server/ssh-client.ts):
  `ssh2.Client`, `term: 'xterm-256color'`, sized at connect time.
  `setWindow` for resize.
- **Local / WSL:** [`pty.spawn`](https://github.com/lydell/node-pty), same
  resolution rules. On Windows, PowerShell paths get an `.exe` suffix
  unless the file already contains a separator or extension.

## Client hook

[`use-terminal-ws.ts`](../%28terminal%29/terminal/use-terminal-ws.ts) is a
small hook that:

1. Picks the WebSocket URL based on `window.location`.
2. Sends the right `connect` / `local` / `wsl` frame on `onopen`, depending
   on `TerminalConfig.type`.
3. Tracks status (`idle | connecting | connected | disconnected`).
4. Auto-reconnects 2s after `onclose` if the user didn't explicitly
   disconnect.
5. Exposes `connect(params)`, `write(data)`, `resize(cols, rows)`,
   `disconnect()`.

`TerminalView` ([terminal-view.tsx](../%28terminal%29/terminal/terminal-view.tsx))
mounts xterm.js, hooks up `ResizeObserver` to `fitAddon.fit()` to
`onResize` to `resize()` to `setWindow / pty.resize`, and writes
red-coloured `[Disconnected: ...]` banners on session-end events.

## Inside a node

The built-in `terminal` window node
([_builtin/core/src/nodes/terminal.tsx](../%28extension-runtime%29/_builtin/core/src/nodes/terminal.tsx))
consumes a `terminal-context` input. It maps the resolved value to a
`TerminalConfig` and renders `TerminalView` directly. Because the same hook
powers it, status indicators, reconnect and resize all behave the same as on
the dedicated terminal page.

## Bookmarks

The standalone terminal page persists bookmarks in the `Setting` table:

| Setting id | Value |
| --- | --- |
| `terminal-bookmarks` | `{ ids: string[] }` (ordering only) |
| `terminal-bookmark:<id>` | `{ id, label, config: SshConnectionConfig }` |

The terminal node on the canvas does **not** use bookmarks; it gets its
config from the connected `terminal-context` source.

## Failure modes worth knowing

- If the terminal server isn't running, the browser hook keeps retrying
  every 2s. You'll see a permanent "connecting..." banner.
- SSH connections that fail (bad host, wrong key, refused) emit an `error`
  frame with the SSH error message. The hook flips to `disconnected`.
- Killing the WebSocket server (Ctrl+C) destroys every session before
  exiting: no orphan PTYs or hanging SSH channels.
