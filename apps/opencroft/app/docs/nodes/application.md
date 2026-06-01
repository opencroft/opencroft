# Application

A Docker Compose service rendered as a single canvas node. Click
**Start** to bring it up.

## Inputs

- **Docker** (`docker-in` · blue): `docker-context`. The daemon to
  deploy to.
- **Volumes** (`volumes-in` · amber): `volume-mount`. Multiple Volume
  nodes can fan in.

## Outputs

None.

## Fields

The inspector groups fields into Basics, Build, Networking, Resources,
Healthcheck, Proxy, Advanced.

**Basics**

- **Name**: compose service name.
- **Image**: `nginx:latest`, `ghcr.io/...`, etc.
- **Ports**: `host:container` per line.
- **Env**: `KEY=value` per line.
- **Secrets**: secret names per line (looked up across Secrets Stores
  and injected as env).
- **Command**, **Entrypoint**, **Working dir**.
- **Container name**: overrides the default `<project>_<service>_<n>`.

**Build**

- **Build context**: directory on the Docker host.
- **Build dockerfile**: path inside the context.

**Resources**

- **Replicas**: for swarm mode.
- **Restart**: `no`, `on-failure`, `always`, `unless-stopped`.
- **Memory limit**, **CPU limit**, **GPU**.
- **Init**, **Read-only**, **IPC**, **shmSize**.

**Healthcheck**

- **Test**, **Interval**, **Timeout**, **Retries**, **Start period**.

**Proxy** (Traefik labels)

- **Domain**, **Entrypoint**, **TLS**, **Basic auth**, **Port**.

**Advanced**

- **DependsOn**, **Group add**, **Security opts**, **tmpfs**,
  **Labels**, **Expose host docker**, **Copy docker binaries**.

## Actions

- **Start**: renders the compose project, runs `docker compose up -d`.
- **Stop**: `docker compose stop` and remove from project.
- **Restart**: `docker compose restart` in place.

## Examples

```
Localhost ── Docker ── Application                 # minimal
Server ── Docker ── Application                    # remote daemon
Volume ─── Application                             # bind mount
Volume ─┐
Volume ─┴─ Application                             # multiple volumes
Application inside a Network frame                 # joins the network
```

## Notes

- Each Application has its own one-service compose project keyed to the
  node id.
- The Application picks up every Network frame it sits inside via
  `containingNodes('network')`.
- For build images, leave **Image** blank and set **Build context**.
- Secrets values are never written to the compose file; they're passed
  as env vars at start time.
