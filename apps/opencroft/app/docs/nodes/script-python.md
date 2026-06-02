# Python Script

A Python script body that runs on any connected target.

## Inputs

- **Target** (`ctx-in` · violet): `terminal-context`. Where `python`
  runs. Defaults to local.
- **Handler** (`exec-in` · orange): `execution-context`. Optional;
  fires the script when an upstream API Route or Event triggers.

## Outputs

None.

## Fields

- **Script**: the Python body. CodeMirror with Python syntax
  highlighting.

## Actions

- **Run**: executes the script via `python <body>` on the target.

## Examples

```
Python Script                          # local one-off
Server ── Python Script                # remote
Event (cron */5) ── Python Script ── Server   # cron, run on remote
API Route ── Python Script             # webhook handler
```

## Notes

- `python` must be on the target's `$PATH`. The script runner doesn't
  install it.
- For webhooks, the request body is piped to stdin. Read it with
  `sys.stdin.read()` or parse JSON with `json.load(sys.stdin)`.
- Cron triggers send an empty body.
- Use `os.environ['OPENCROFT_PARAM_*']` to read action params.
