# Spaces

A space is one canvas. You can have as many as you want.

> **Tip.** Use spaces to keep diagrams isolated: `homelab`, `work-vps`,
> `playground`. Wires don't cross between them.

## Switch spaces

Click the space name at the top of the canvas. The dropdown lists every
space you have. Pick one to switch.

The active space persists across reloads. Opening `/` redirects to it.

## Create, rename, delete

In the dropdown:

- **+ New space**: name it; the URL slug is generated and made unique.
- **Rename**: only the display name changes; the slug is permanent.
- **Delete**: refuses to drop your last `default` space. Otherwise it's
  gone for good (export first if you might want it back).

## Export

Pick **Export** in the space submenu. You get a JSON file with the full
graph (nodes, edges, every node's settings).

## Import

Pick **Import** in the dropdown. The imported space is added with a
fresh, unique slug. Duplicates don't overwrite. Hand-edit the JSON
beforehand to scrub IPs or tokens if you need to.

## Auto-save

Every change auto-saves 500 ms after you stop editing. There's no Save
button. There's also no global undo. Export before doing anything you
might regret.
