# OpenCroft

> A visual graph workspace for your homelab. Drop boxes on a canvas, draw
> wires between them, and your servers, containers, scripts and webhooks
> just *work*.

OpenCroft turns "I have a box of YAML and shell scripts" into a picture you
can read in a glance. Each box is a node. Each wire is a typed connection.
Click **Start**; the thing starts.

## Use cases

- Run Docker Compose services on local, WSL or remote hosts without
  hand-writing a `compose.yml`.
- Wire a webhook to a script. Wire a cron schedule to the same script.
- Browse files on a remote box without leaving the canvas.
- Hand the whole graph to Claude (or any MCP client) and let it
  audit, edit or operate it.

## Quick start

1. [Get OpenCroft running](getting-started.md).
2. [Drop your first nodes](canvas-basics.md).
3. [Point them at a target](connecting-targets.md).
4. [Deploy something](deploying-applications.md).

## Guides

- [Spaces](spaces.md): keep separate diagrams, switch between them,
  export and import.
- [Canvas basics](canvas-basics.md): palette, inspector, handles, key
  bindings.
- [Connecting to targets](connecting-targets.md): Localhost, WSL, SSH
  servers, Docker contexts.
- [Deploying applications](deploying-applications.md): Docker Compose
  services with volumes, networks, secrets.
- [Scripts and automation](scripts-and-automation.md): bash, Python and
  Node scripts; API routes; scheduled events.
- [Secrets and SSH keys](secrets-and-keys.md): encrypted values and key
  storage that don't leak into your graph.
- [Files and terminals](files-and-terminals.md): embedded terminal and
  file-browser windows.
- [Extensions](extensions.md): install user extensions, write your own,
  hot-reload.
- [AI integration](ai-integration.md): connect Claude or any MCP client.

## Reference

- [Node catalog](../nodes/README.md): one page per built-in node.
- [Technical docs](../README.md): architecture and internals.

## What's next

The roadmap lives in the [Extensions](extensions.md) and
[AI integration](ai-integration.md) pages. Both are open for contribution.
