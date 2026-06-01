# Bash Script

A bash script body that runs on any connected target. Click **Run** to
execute.

## Inputs

- **Target** (`ctx-in` · violet): `terminal-context`. Optional; runs
  locally if not connected.

## Outputs

None.

## Fields

- **Script**: the bash body. CodeMirror with bash syntax highlighting.

## Actions

- **Run**: executes the script in the connected target via `bash -c`.

## Examples

```
Bash Script                 # runs on the OpenCroft host
Server ── Bash Script       # runs on the remote box
WSL    ── Bash Script       # runs in the WSL distro
```

## Notes

- Stdout/stderr stream to the inspector's terminal tab.
- Failures stamp a red banner on the node; the next successful run
  clears it.
- Pair with a Secrets Store: name secrets in your script body via
  `$NAME`. Values are decrypted into env at run time.
