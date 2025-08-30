# Server

A remote SSH host. Connects via the `ssh2` library.

## Inputs

None directly, but connect a **Key Store** for key auth.

## Outputs

- **Terminal** (`ssh-out` · violet): `terminal-context`.
- **Files** (`fs-out` · green): `filesystem-target`.

## Fields

- **Name**: display name on the canvas.
- **Address**: host or IP.
- **Port**: defaults to `22`.
- **Username**: defaults to `root`.
- **Password**: plaintext password auth (consider a Secrets Store
  instead).
- **Key**: dropdown that lists keys from a connected Key Store.

## Actions

None on the manifest, but the inspector includes a **Stats** tab that
runs `uname / cat /etc/os-release / free -h / df -h /` to verify the
connection.

## Examples

```
Key Store ── Server ── Terminal Window
Key Store ── Server ── Docker ── Application
Server ── File Manager Window
```

## Notes

- Both outputs carry the same target descriptor: terminal and
  filesystem are two views of the same SSH connection.
- The private key never leaves OpenCroft's process. The Server reads it
  from the Key Store at connect time.
- For remote-Docker-over-SSH, chain Server → Docker.
