# API Route

Registers an HTTP endpoint under `/api/route/<path>`. Requests fire the
connected handler.

## Inputs

None.

## Outputs

- **Handler** (`exec-out` · orange): `execution-context`. Connect to a
  script's **Handler** input.

## Fields

- **Path**: segment under `/api/route/`. E.g. `webhook/github` →
  `/api/route/webhook/github`.
- **Method**: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`. Default `POST`.

## Actions

None.

## Examples

```
API Route (POST /api/route/webhook/github) ── Python Script ── Server
```

GitHub posts to the URL; the Python script runs on the remote Server.

```
API Route (GET /api/route/health) ── Bash Script
```

Calling the URL fires a one-shot health check.

## Notes

- The route is mounted on the Next.js app: same origin as the canvas
  (default `http://localhost:9999`).
- The request body is piped to the script's stdin verbatim.
- Headers and method are exposed to the handler via the execution
  context (read in scripts via `OPENCROFT_PARAM_*`).
- No auth on the route by default. Put a reverse proxy in front if you
  need it.
