# AI integration

OpenCroft ships an **MCP server** at `/api/mcp`. Point any
[Model Context Protocol](https://modelcontextprotocol.io) client at it :
Claude Desktop, Claude Code, your own: and the agent can drive the same
workflows you drive.

> **Heads up.** There's no auth on `/api/mcp`. Run it on a trusted
> network or proxy it behind one with auth.

## What an agent can do

- **Spaces:** list, create, rename, delete.
- **Graph:** list / find / create / update / delete nodes; connect and
  disconnect handles; list edges.
- **Focus and comments:** focus a node in the canvas, drop comment
  bubbles, broadcast toasts.
- **Extensions:** list, read, create, update, delete, compile local
  extensions.
- **Docs:** search, read, edit, write markdown under `app/docs/`.
- **Remote files / exec:** read, write, edit files on any connected
  target; run shell commands; inject secrets as env vars.
- **Node actions:** list and call any node's manifest actions
  (Start / Stop / Run / …).

The agent talks to the same code paths the UI uses. Whatever it changes
shows up live in every open canvas tab.

## Connect Claude Code

```bash
claude mcp add --transport http opencroft http://localhost:9999/api/mcp
```

Now `claude` can `list_nodes`, `remote_exec`, etc.

## Connect Claude Desktop

Add to your Desktop config:

```json
{
  "mcpServers": {
    "opencroft": {
      "transport": "http",
      "url": "http://localhost:9999/api/mcp"
    }
  }
}
```

## Common patterns

### "Audit my homelab graph"

The agent calls `list_spaces`, then `get_nodes` per space. It can
summarise what's running where, flag duplicate config, suggest missing
networks.

### "Restart the broken service"

```
list_actions(nodeId) → ["start", "stop", "restart"]
call(nodeId, "restart")
```

The button click and the MCP call run identical code.

### "Edit this docker-compose-ish config"

The agent edits the Application's fields with `update_nodes`, then
`call(nodeId, "start")`. The canvas updates while it works.

### "Inspect this container"

```
remote_exec(target="server/ssh-out", command="docker logs nginx --tail 50")
```

Stdout streams back to the agent. The user sees the toast that the
command ran.

### "Pin a comment for the user"

```
comment_nodes([{ nodeId, message: "I restarted this: it was OOM-killed" }])
```

Floating bubbles appear above the targeted nodes in every open tab.

## Endpoint shapes you'll see

Every graph tool takes an optional `space` arg (slug or name; defaults
to active). Edge endpoints look like `node-id/handle-id`. See
[mcp.md](../mcp.md) for the full schema.

## The `remote_exec` permission flow

`remote_exec` runs commands on remote machines. By convention, agents
include a short human-readable `description` so a permission prompt UI
can show it. Inject any needed Secrets Store values via the `secrets`
arg: values never come back to the agent, only into the executor's
env.

## What the agent *can't* do

- Change settings under `/settings/*` (other than via direct MCP doc
  edits).
- Write to built-in extensions (`builtin/core/...`).
- Modify the SQLite schema or the encryption key.

## Integrate your own client

The transport is plain MCP-over-HTTP. Any MCP SDK works. Use
`tools/list` to discover what's exposed; `tools/call` to invoke.
