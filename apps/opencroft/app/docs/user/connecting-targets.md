# Connecting to targets

A "target" is anywhere OpenCroft can run a command or read a file:
your machine, a WSL distro, a remote SSH host, a Docker daemon. Almost
every other node eventually needs one as input.

## Localhost

Drop a **Localhost** node. Nothing to configure. It exposes:

- **Terminal** (`ssh-out`): runs commands locally via `child_process`.
- **Files** (`fs-out`): reads and writes the local filesystem.

Use it for quick tests.

## WSL

Drop a **WSL** node. Pick a distro from the dropdown. The inspector
calls `wsl --list` for you.

Same two outputs as Localhost. Commands run as
`wsl -d <distro> --exec ...`.

> Windows hosts only.

## Server (SSH)

Drop a **Server** node. Fill in:

- **Address**: host or IP.
- **Port**: defaults to 22.
- **Username**: defaults to `root`.
- **Auth**: either a password field, or a Key dropdown that picks a
  private key from a connected Key Store.

For key auth: connect a **Key Store** node into the Server, then pick
the key in the dropdown. The matching public key never leaves OpenCroft.

The **Stats** tab in the inspector pings the host with `uname /
free -h / df -h /` so you can confirm the connection works.

## Docker

A **Docker** node is the entry point for any Docker action.

- **Local Docker:** leave inputs empty. Defaults to `docker` on the
  OpenCroft host.
- **WSL Docker:** connect a WSL node into Docker's `Host` input.
- **Remote Docker over SSH:** connect a Server node into `Host`.

Optional **Context** input pre-loads `docker context use <name>`. Pin
the context in the inspector's **Context name** field too.

## Common shapes

```
Localhost ── Terminal Window      # try out commands locally
Server   ─── Terminal Window      # interactive shell on a remote host
Server   ─── Docker  ── Application   # deploy to a remote daemon
WSL      ─── File Manager Window  # browse files inside a WSL distro
```

A Server can fan out: Terminal to a Terminal Window, Files to a
File Manager Window, Terminal to a Docker node, all from the same
Server.
