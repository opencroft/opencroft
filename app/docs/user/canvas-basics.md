# Canvas basics

The canvas is where you'll spend your time. The interactions are
deliberately few.

## Drop a node

Two ways:

- **From the palette**: open it (button top-left), drag any node onto
  the canvas.
- **From a handle**: drag from a handle on an existing node into empty
  canvas. A filtered menu appears with only nodes that can connect.
  Pick one; both the node *and* the wire are created.

## Select and edit

Click a node to select it. The right-side **inspector** opens.

The inspector has:

- **Details**: the node's fields. Edits auto-save.
- **Tabs**: extension-contributed views (live stats, embedded terminals,
  logs).
- **Actions**: buttons that map to manifest actions (Start, Stop, Run, …).

Multi-select with `Shift+click` or by lassoing empty canvas. Right-click
for delete / duplicate / comment / focus.

## Connect handles

Handles are the coloured dots on the sides of a node. The colour matches
the **context type** that handle deals with: terminals are violet, files
are green, Docker is blue, volumes are amber.

A connection is allowed only if:

- both handles share the same context type, and
- one is a source (right side), the other a target (left side).

> **Tip.** Don't bother memorising what fits where. Drag from a handle
> into empty canvas. The menu shows only what's compatible.

Double-click any handle to disconnect every wire attached to it.

## Frames

**Section** and **Domain** nodes are visual containers. Drop other
nodes inside them. Frames sit *behind* their contents.

Some nodes look at their parent frames at runtime. e.g. an
**Application** picks up every Network frame it sits inside.

## Comments

Right-click a node, then **Comment**. A floating bubble appears above it.
Comments don't save with the graph; they're broadcast over SSE so every
open tab shows the same thing.

AI agents drop comments through MCP. That's the "explain what's
happening" channel.

## Keyboard

- `Delete` / `Backspace`: remove selection.
- `Ctrl+C` / `Ctrl+V`: copy/paste (new IDs are generated).
- `Ctrl+A`: select all.
- `Ctrl+/`: open the command bar.
- `Esc`: close menu / inspector / command bar.

## Command bar

`Ctrl+/` opens a command bar that jumps to any node by name across the
active space. Extensions can add modes: search docs, run ad-hoc commands,
whatever they want.
