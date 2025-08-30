# Deploying applications

The **Application** node wraps `docker compose`. Give it an image, point
it at a Docker daemon, click **Start**.

## Minimum viable app

```
Localhost ── Docker ── Application
```

1. Drop a **Localhost**, a **Docker**, an **Application**.
2. Connect Localhost's **Terminal** to Docker's **Host**.
3. Connect Docker's **Docker** output to the Application's **Docker**
   input.
4. Select the Application. Set:
   - **Name**: `nginx` (becomes the compose service name).
   - **Image**: `nginx:latest`.
   - **Ports**: `8080:80` (one per line).
5. Click **Start**.

Output and errors stream to the inspector's terminal tab. The Action
either toasts green, or stamps a red banner on the node.

## Volumes

Drop a **Volume** node. Connect its **Volume** output to the
Application's **Volumes** input. Multiple volumes fan in.

In the Volume inspector:

- **Host path**: bind mount on the Docker host.
- **Container path**: where it appears inside the container.
- **Read-only**: adds `:ro`.

Edit volumes while the container runs, then click **Restart**. The
project gets re-rendered.

## Networks

Wrap related services in a **Network** frame. Every Application sitting
inside joins that network.

```
+-- Network "frontend" -----+
|                            |
|  Application "web"         |
|  Application "api"         |
+----------------------------+
```

Set the network's **driver** and **external** flag in its inspector.
For visual grouping without a network, use **Section** or **Domain**
instead.

## Secrets and env vars

In the Application inspector:

- **Env**: one `KEY=value` per line. Plain values.
- **Secrets**: one secret name per line. Each name is looked up across
  every Secrets Store node, decrypted at start time, passed to compose
  as env vars. Values never hit the compose file or disk.

Name the secret in a [Secrets Store](secrets-and-keys.md) first. Then
add the same name to the Application's **Secrets** field.

## Lifecycle actions

- **Start**: renders the compose project, runs `up -d`.
- **Stop**: `docker compose stop` and remove the container.
- **Restart**: `docker compose restart` in place.

## Build context

For local builds, leave **Image** blank and set:

- **Build context**: directory on the Docker host.
- **Build dockerfile**: path inside the context (defaults to
  `Dockerfile`).

**Start** builds first, then runs.

## Advanced fields

The Application inspector groups extras:

- **Resources**: `requirementMemory`, `requirementCpu`.
- **Healthcheck**: `test`, `interval`, `timeout`, `retries`,
  `startPeriod`.
- **Replicas**: for swarm mode.
- **Restart policy**: `no`, `on-failure`, `always`, `unless-stopped`.
- **Init**, **Read-only**, **GPU**, **Working dir**, **Entrypoint**,
  **Command**, **IPC**, **shmSize**, **DependsOn**, **Group add**,
  **Security opts**, **tmpfs**, **Labels**.
- **Proxy**: `proxyDomain`, `proxyPort`, `proxyTls`, `proxyEntrypoint`,
  `proxyBasicAuth`. Adds Traefik labels. Pair with a Traefik container
  on the same network.
- **Container name**: overrides the default `<project>_<service>_<n>`.

## Remote Docker

```
Server ── Docker ── Application
```

The Application deploys to the remote daemon over SSH. Volumes refer to
paths on the *remote* host.

## Multi-network setups

A Traefik proxy on an "edge" network, services on their own network,
both wrapped in a parent edge network. Each Application joins every
parent Network frame it's inside.
