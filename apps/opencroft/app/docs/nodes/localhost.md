# Localhost

Represents the machine OpenCroft itself runs on. Anything connected to
its outputs runs locally.

## Inputs

None.

## Outputs

- **Terminal** (`ssh-out` · violet): `terminal-context`. Runs commands
  via `child_process`.
- **Files** (`fs-out` · green): `filesystem-target`. Reads and writes
  the local filesystem.

## Fields

None. Localhost is configuration-free.

## Actions

None.

## Examples

```
Localhost ── Terminal Window     # ad-hoc local shell
Localhost ── Docker ── App       # local docker compose
Localhost ── Bash Script         # run a script locally
```

## Notes

- Same target shape as WSL and Server, so anything downstream treats
  them the same.
- Useful for quick tests and local development.
- "Local" means *the OpenCroft host process*, not your laptop if you're
  running OpenCroft on a remote.
