# Node catalog

One page per built-in node. Every page has the same structure:

- **What it is**: one or two sentences.
- **Inputs / Outputs**: handles, by name and context type.
- **Fields**: what's in the inspector.
- **Actions**: buttons in the inspector's Actions panel.
- **Examples**: wiring diagrams that show common uses.
- **Notes**: quirks, limits, platform restrictions.

All nodes ship in the [`builtin/core`](../extension-system.md) extension.

## Infrastructure

> Where commands run.

- [Localhost](localhost.md)
- [WSL](wsl.md)
- [Server](server.md)
- [Docker](docker.md)
- [Git Workspace](git-workspace.md)

## Storage

> Encrypted values and SSH keys.

- [Key Store](key-store.md)
- [Secrets Store](secrets-store.md)

## Windows

> Embedded UIs on the canvas.

- [Terminal Window](terminal.md)
- [File Manager Window](file-manager.md)

## Scripts

> Code bodies you can run on any target.

- [Bash Script](script-bash.md)
- [Python Script](script-python.md)
- [Node.js Script](script-node.md)

## Applications

> Compose-style services.

- [Application](application.md)
- [Volume](volume.md)
- [Network](network.md)

## Integration

> Webhooks and schedules.

- [API Route](api-route.md)
- [Event](event.md)

## Organization

> Frames for grouping.

- [Section](section.md)
- [Domain](domain.md)

## Context type cheat sheet

Wires are colour-coded by context type:

- **violet: terminal-context**: a target where commands run
  (local / WSL / SSH).
- **green: filesystem-target**: same target, but for file ops.
- **blue: docker-context**: a Docker daemon (terminal + context name).
- **amber: volume-mount**: a `host:container[:ro]` mount.
- **orange: execution-context**: async request/response handler for
  routes and scheduled events.
