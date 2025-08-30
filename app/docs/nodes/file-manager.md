# File Manager Window

A file browser embedded on the canvas. Connect a target's **Files**
output to its **Files** input.

## Inputs

- **Files** (`fs-in`, green): `filesystem-target`.

## Outputs

None.

## Fields

None on the node. The browser exposes path navigation, drag-drop
upload, and right-click rename / delete / download.

## Actions

None on the manifest. Per-file actions in the browser UI:

- **Upload**: drag from your OS into the window.
- **Download**: right-click, then Download.
- **Rename**: right-click, then Rename.
- **Delete**: right-click, then Delete.
- **New folder**: `+` button.

## Examples

```
WSL       -- File Manager Window
Server    -- File Manager Window
Localhost -- File Manager Window
```

## Notes

- Default size 800x480.
- Switching the upstream target re-mounts the browser at the new
  target's root.
- For S3 / Docker / SSH connections without a graph wire, use the
  standalone `/files` page instead.
