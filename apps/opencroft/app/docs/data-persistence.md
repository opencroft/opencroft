# Data persistence

OpenCroft uses SQLite via Prisma 7 with the better-sqlite3 adapter. There is
exactly one database file: `data/opencroft.db` (resolved by
[server/prisma.ts](../../server/prisma.ts)). The Prisma client is a global
singleton: Next.js hot reload would otherwise create a fresh client on
every recompile, exhausting better-sqlite3's connection pool.

## The schema

Four tables. The whole [schema.prisma](../../prisma/schema.prisma):

```prisma
model Setting {
  id        String   @id
  data      String   @default("{}")    // JSON blob
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Secret {
  id        String   @id @default(cuid())
  storeId   String
  key       String
  value     String                     // AES-GCM encrypted
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([storeId, key])
  @@index([storeId])
}

model AppLink {
  id    String @id @default(cuid())
  title String
  url   String
  order Int    @default(0)
}

model Space {
  id        String   @id @default(cuid())
  slug      String   @unique
  name      String
  data      String   @default("{\"nodes\":[],\"edges\":[]}")  // GraphData JSON
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

## Setting

A generic key/value store. Used everywhere a feature wants to persist a
small JSON blob. Some well-known IDs:

| ID | Shape | Owner |
| --- | --- | --- |
| `active-space-slug` | `{ slug }` | [`SpacesRegistry`](../%28space%29/server/store.ts). |
| `app-dashboard-mvp-graph` | `GraphData` | Legacy single-space blob. Migrated into a `Space` row on first load and ignored afterward. |
| `extension-storage` | `{ [extensionId::key]: any }` | The per-extension storage API exposed via `host.storage.*`. |
| `terminal-bookmarks`, `terminal-bookmark:<id>` | bookmark map | Terminal page. |
| `ai-settings` | OpenAI base URL, model defaults | The AI settings page (`(settings)/settings/ai`). |

The accessors:

```ts
// app/(settings)/server/actions.ts
getSetting<T>(id)        // → Setting<T> | null
setSetting<T>(id, data)  // upserts
updateSetting<T>(id, partial)
deleteSetting(id)
```

These wrap the row helpers in [server/data.ts](../../server/data.ts), which
in turn talk to Prisma.

## Space

One row per space. The graph itself is `data`: a JSON-encoded
`GraphData` (`{ nodes, edges }`). See [spaces-and-graph.md](spaces-and-graph.md)
for how it's loaded, mutated and saved.

The `slug` column is unique. Slugs are generated from the user's name input
by `slugify()` and disambiguated by `uniqueSlug()`
([app/(space)/server/slug.ts](../%28space%29/server/slug.ts)).

The `data` column is rewritten on every save. There is no node-level diff
or per-edge row. Saves are single Prisma `update` calls: atomic, fast on
homelab-scale graphs, and easy to back up.

## Secret

A row per (`storeId`, `key`) pair. `storeId` matches a Secrets Store node's
id, so deleting the node implicitly orphans its secrets (the
`(secrets-store)/secrets-store/actions.ts` `deleteStore(storeId)` helper
cleans them up).

Encryption ([server/crypto.ts](../../server/crypto.ts)):

- AES-256-GCM, 12-byte IV, 16-byte auth tag.
- Key is derived via `scryptSync(passphrase, SALT, 32)`.
- Passphrase comes from `process.env.SECRETS_KEY`, default
  `'homelab-default-key'`.
- The salt is hard-coded in `crypto.ts`. To rotate it, run
  [scripts/migrate-secrets-salt.ts](../../scripts/migrate-secrets-salt.ts);
  it decrypts every row with the old salt, re-encrypts with a fresh random
  salt, writes the new salt back to `crypto.ts`, and backs up the old DB.

The `host.crypto.encrypt` / `host.crypto.decrypt` available to extensions
are aliases for these functions, so an extension can encrypt extra data
under the same key.

## AppLink

Sidebar bookmarks shown in `app-layout.tsx`. CRUD lives in
[`app/(applink)/`](../%28applink%29/) (server actions:
`getAppLinks`, `createAppLink`, `deleteAppLink`).

## Migrations

`prisma migrate` is the source of truth. Generated migrations are committed
under `prisma/migrations/`. The `data/` folder holds the runtime DB and is
gitignored.

There's no automatic `prisma migrate deploy` on app boot. After updating the
schema you run:

```
npx prisma migrate dev      # in dev, after editing schema.prisma
npx prisma migrate deploy   # in prod, after pulling new code
```

## Data on disk

Outside the SQLite file, OpenCroft writes a few other things into `data/`:

| Path | Purpose |
| --- | --- |
| `data/opencroft.db` | The Prisma SQLite database. |
| `data/opencroft.db.pre-salt-migration.bak` | Optional backup written by the salt-migration script. |
| `data/extensions/local/<slug>/` | Local extension folders. |
| `.cache/extensions/<id>/` | Per-extension cache directory exposed via `host.cacheDir(...)`. Holds e.g. SSH keys for the Key Store node. |

`OPENCROFT_EXT_ROOT` overrides `data/extensions/local/`. Nothing overrides
the DB path or the cache path.

## Backup and restore

Recommended approach for a single-user setup: stop the dev server, copy
`data/opencroft.db` and `data/extensions/local/`, and you have everything.
The `.cache/extensions/` folder is regenerated as needed (and includes
generated SSH keys, so include it if you want to keep those).

Per-space export is built in (`exportSpace(slug) → SpaceExport`) and
roundtrips through `importSpace(payload)` to a freshly slugified row.
