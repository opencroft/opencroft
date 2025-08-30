# Node.js Script

A JavaScript script body that runs on any connected target via `node`.

## Inputs

- **Target** (`ctx-in` · violet): `terminal-context`. Where `node`
  runs. Defaults to local.
- **Handler** (`exec-in` · orange): `execution-context`. Optional;
  fires the script when an upstream API Route or Event triggers.

## Outputs

None.

## Fields

- **Script**: the JS body. CodeMirror with JS syntax highlighting.

## Actions

- **Run**: executes the script via `node -e <body>` on the target.

## Examples

```
Node.js Script                              # local one-off
Server ── Node.js Script                    # remote
Event (cron 0 0 * * *) ── Node.js Script   # nightly job
API Route (POST) ── Node.js Script          # webhook handler
```

## Notes

- `node` must be on the target's `$PATH`.
- For webhooks, the request body is piped to stdin. Use
  `process.stdin.toArray()` (Node 21+) or accumulate `'data'` events.
- Pair with a Secrets Store: named secrets are injected as env vars,
  read with `process.env.NAME`.
