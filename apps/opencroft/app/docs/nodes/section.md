# Section

A visual frame for grouping related nodes. Has no compose or runtime
effect.

## Inputs

None.

## Outputs

None.

## Fields

- **Label**: text shown at the top of the frame.

## Actions

None.

## Examples

```
+-- Section "monitoring" -----+
|                              |
|  Application "prometheus"    |
|  Application "grafana"       |
+------------------------------+
```

Use sections to chunk a large graph into visually obvious areas.

## Notes

- Default size 400x300; resize with the corner handle.
- Renders behind contained nodes (`zIndex: -1`).
- Custom extensions can read a node's parent Section via
  `containingNodes('section')` if they want section-aware behaviour.
