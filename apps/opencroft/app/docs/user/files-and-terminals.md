# Files and terminals

Two "window" nodes that embed a UI inside the canvas:

- **Terminal Window**: an xterm.js terminal connected to any target.
- **File Manager Window**: a file browser connected to any target.

Both are big (default 800x480) and resizable.

## Terminal Window

Drop a **Terminal Window**. Connect a target's **Terminal** output to
the window's **Terminal** input.

```
Server -- Terminal Window
```

Hit Enter, you're in. Type, paste, resize, scroll.

The window auto-reconnects if the connection drops. Switching the
upstream target re-connects to the new one.

> **Tip.** You don't need a terminal node to run scripts. Those have
> their own runner. Use Terminal Window for ad-hoc work.

## Standalone /terminal

Visit <http://localhost:9999/terminal>. Same xterm.js, but with
bookmarked SSH connections in a sidebar.

Bookmarks are stored in the SQLite database. CRUD them with the
bookmark form in the sidebar.

## File Manager Window

Drop a **File Manager Window**. Connect a target's **Files** output to
the window's **Files** input.

```
WSL -- File Manager Window
```

You get a typical file browser:

- Click a folder to enter, **Backspace** to go up.
- Drag files in from your OS to upload (folders included).
- Right-click any entry for **Rename**, **Delete**, **Download**.
- The **+** button creates a new folder.

Uploads queue in parallel. Each upload shows a progress bar.

## Standalone /files

Visit <http://localhost:9999/files>. Same browser, but with stored
**connections** in a sidebar:

- **S3**: endpoint, region, bucket, access keys.
- **SSH**: host, port, username, password / private key, base path.
- **WSL**: distro and base path.
- **Docker**: container ID, base path, optional context.

Connections persist across runs.

## Combining windows

Drop a Terminal Window *and* a File Manager Window connected to the same
Server. Edit a config in the file browser, run it in the terminal.
Everything happens against the same target.

## Reconnect behaviour

- A network blip on a Terminal Window: reconnect happens after 2 s.
- A failed SSH auth: window goes red with the error. Fix the upstream
  and the window heals on the next save.
- The standalone `/terminal` page shows status dots in the tab bar.
