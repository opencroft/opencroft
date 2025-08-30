# WSL

A Windows Subsystem for Linux distro. Commands run as
`wsl -d <distro> --exec ...`.

## Inputs

None.

## Outputs

- **Terminal** (`ssh-out` · violet): `terminal-context`.
- **Files** (`fs-out` · green): `filesystem-target`.

## Fields

- **Distro**: pick from your installed list. The inspector calls
  `wsl --list` for you.

## Actions

None.

## Examples

```
WSL ── Terminal Window           # interactive shell in the distro
WSL ── Docker ── Application     # docker that's installed inside WSL
WSL ── File Manager Window       # browse files in the distro
```

## Notes

- Windows hosts only. On Linux/macOS, the dropdown is empty.
- Use **Copy to WSL** on a Key Store key to mirror SSH keys into
  `~/.ssh/keys/` inside the distro. Useful when SSH commands run via
  WSL.
