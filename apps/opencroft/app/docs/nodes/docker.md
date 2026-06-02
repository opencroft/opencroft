# Docker

The entry point for any Docker action. Wraps a Docker daemon (local,
WSL, remote, or named context).

## Inputs

- **Host** (`ctx-in` · violet): `terminal-context`. The shell where
  `docker` runs. Empty = local.
- **Context** (`context-in` · violet): `terminal-context`. Optional
  alternative context.

## Outputs

- **Docker** (`docker-out` · blue): `docker-context`. Carries the
  upstream terminal target plus the resolved Docker context name.

## Fields

- **Context name**: pins a specific `docker context` (e.g. `prod`).
  Combine with a Server input to use a remote daemon.

## Actions

None. Downstream Application nodes call Docker actions like `docker.up`,
`docker.ps`, `docker.listContainers` via the host bus.

## Examples

```
Localhost ── Docker ── Application       # local docker compose
WSL      ── Docker ── Application        # docker installed inside WSL
Server   ── Docker ── Application        # remote docker over SSH
```

For a named remote context:

```
Server ── Docker (contextName: "prod") ── Application
```

## Notes

- Empty `Host` input means `{ type: 'local' }`: the Docker CLI on the
  OpenCroft host.
- The Docker output is what Application, Volume-aware nodes and the
  containers/images pages consume.
