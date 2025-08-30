# Volume

A bind mount definition. Connect to an Application's **Volumes** input
to mount it.

## Inputs

None.

## Outputs

- **Volume** (`vol-out` · amber): `volume-mount`.

## Fields

- **Host path**: the path on the Docker host.
- **Container path**: the path inside the container.
- **Read-only**: checkbox; adds `:ro`.

## Actions

None.

## Examples

```
Volume ── Application                         # one mount
Volume ─┐
Volume ─┴─ Application                        # multiple mounts
```

## Notes

- Both **Host path** and **Container path** must be set; otherwise the
  mount is ignored.
- The host path is on the *Docker daemon's* filesystem, not OpenCroft's
 : when deploying remotely, that means the remote box.
- Volumes resolve at start time, so editing them while the container
  runs is fine: click **Restart**.
