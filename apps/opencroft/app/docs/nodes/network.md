# Network

A Docker network defined as a frame on the canvas. Drop other nodes
inside; they join the network at compose time.

## Inputs

None.

## Outputs

None.

## Fields

- **Network name**: the compose network name.
- **Driver**: `bridge`, `overlay`, `host`, `none`. Default `bridge`.
- **External**: checkbox; if true, the compose project references an
  existing network instead of creating one.

## Actions

None.

## Examples

```
+-- Network "frontend" -----------+
|                                  |
|  Application "web"               |
|  Application "api"               |
+----------------------------------+
```

Both apps join the `frontend` network when started.

For multi-network apps, nest frames:

```
+-- Network "edge" ---------------+
|  +-- Network "frontend" -----+  |
|  |  Application "traefik"    |  |
|  +---------------------------+  |
|  +-- Network "backend" ------+  |
|  |  Application "api"        |  |
|  +---------------------------+  |
+--------------------------------+
```

`api` joins `backend` and `edge`. `traefik` joins `frontend` and `edge`.

## Notes

- Network is a *visual frame*: it has no graph wires of its own.
- An Application discovers parent networks at start time; restart it
  after wrapping it in a new frame.
- For visual grouping with no compose effect, use **Section** or
  **Domain** instead.
