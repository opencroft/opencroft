# Terminal Window

An xterm.js terminal embedded on the canvas. Connect a target's
**Terminal** output to its **Terminal** input.

## Inputs

- **Terminal** (`ssh-in`, violet): `terminal-context`. The session
  to attach to.

## Outputs

None.

## Fields

None on the node. The window itself has standard xterm controls
(scroll, paste, copy with selection).

## Actions

None.

## Examples

```
Server    -- Terminal Window
WSL       -- Terminal Window
Localhost -- Terminal Window
```

## Notes

- Default size 800x480; resize with the corner handle.
- Auto-reconnects 2 s after a drop.
- Switching the upstream target reconnects to the new one.
- Uses the standalone WebSocket terminal server (`npm run dev:ws`,
  port 3334). Without that process running, the window stays in
  "connecting..." forever.
