# Key Store

Holds SSH private keys. Connect to a Server node to pick one in the
Server's auth dropdown.

## Inputs

None.

## Outputs

None: keys are read by querying the node directly, not via wires.

## Fields

A list of stored keys. Each entry shows:

- **Name**: `id_ed25519`, `homelab`, etc.
- **Type**: `ed25519`, `rsa`, …
- **Fingerprint**: short hash from `ssh-keygen -l`.
- **Public key present**: checkmark if the `.pub` exists.
- **In WSL**: checkmark if mirrored to WSL `~/.ssh/keys/`.

## Actions

- **Generate key**: runs `ssh-keygen -t <type> -f <path> -N ''`.
- **Import key**: paste an existing private key.
- **Read public key**: copies `.pub` content (or generates it from the
  private key if missing).
- **Copy to WSL**: duplicates the key into the default WSL distro's
  `~/.ssh/keys/` with `chmod 600`.
- **Remove from WSL**: deletes the WSL copy only.
- **Delete**: removes both private and public files.

## Examples

```
Key Store ── Server ── Terminal Window
```

The Server's key dropdown lists every key in the connected Key Store.

## Notes

- Keys live under `.cache/extensions/builtin/core/key-store/<storeId>/`.
  They're not in the graph JSON; they're not in the SQLite database.
- On Windows, file permissions are set with `icacls` instead of
  `chmod 600`.
