# Domain

A visual frame, same as Section but with a globe icon. Convention is to
use Domain for logical environments (prod, staging, dev) and Section
for functional groups (monitoring, ingress).

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
+-- Domain "production" -------------------+
|                                           |
|  +-- Section "monitoring" --+             |
|  |                            |             |
|  |  Application "grafana"     |             |
|  +----------------------------+             |
|                                           |
|  +-- Section "ingress" -----+              |
|  |                            |             |
|  |  Application "traefik"     |             |
|  +----------------------------+             |
+-------------------------------------------+
```

Nest Sections inside a Domain to keep both axes (environment and
function) visible.

## Notes

- Default size 400x300.
- Renders behind contained nodes.
- Behaviourally identical to Section. The difference is the icon and
  the name. Pick whichever matches your mental model.
