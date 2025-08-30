# Getting started

Get OpenCroft on your machine in three minutes. No cloud, no signup.
Your graphs and secrets live in the project folder.

## Install

You need Node.js 20+ and `npm`. On Windows, install WSL too if you plan to
use the WSL node.

```bash
git clone <repo-url> opencroft
cd opencroft
npm install
```

The `postinstall` script copies VAD audio assets into `public/`. If you're
on a fresh install and see warnings about missing assets, run
`node scripts/copy-vad-assets.mjs` manually.

## Run

Open two terminals.

**Terminal 1, the app:**

```bash
npm run dev
```

The UI is on <http://localhost:9999>.

**Terminal 2, the WebSocket terminal server:**

```bash
npm run dev:ws
```

The terminal server only matters if you'll use Terminal nodes or the
standalone `/terminal` page. Skip it if you don't.

> **Tip.** Add a third process, `npm run dev:ext`, to live-rebuild
> local extensions whenever their files change.

## First launch

Open <http://localhost:9999>. You see:

- A **sidebar** on the left with bookmarks, your active space, docs, and
  settings.
- An empty **canvas** in the middle.
- A **palette button** in the top-left. Click it to start dragging nodes.

You're in a default space called "Default". Make as many spaces as you
like. See [spaces](spaces.md).

## What's on disk

Everything OpenCroft writes lives under your project folder.

- `data/opencroft.db`: your spaces, settings and encrypted secrets.
- `data/extensions/local/`: extensions you've authored.
- `.cache/extensions/`: generated SSH keys and other extension caches.

To back up: copy `data/` and `.cache/`. To start fresh: delete them.

## Encrypt your secrets

OpenCroft encrypts everything in the Secrets Store. By default it uses a
hard-coded passphrase, fine for a sandbox, not fine for anything else.
Set a real one before you store anything sensitive:

```bash
SECRETS_KEY="my-strong-passphrase" npm run dev
```

If you change `SECRETS_KEY` *after* storing secrets, see
[secrets-and-keys.md](secrets-and-keys.md) for the migration script.

## Where to next

- [Canvas basics](canvas-basics.md): drop your first nodes.
- [Deploying applications](deploying-applications.md): start an nginx
  container in five clicks.
