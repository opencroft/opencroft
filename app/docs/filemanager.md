# File manager

A file browser that talks to four kinds of storage backend through one
unified UI: S3, SSH (SFTP), WSL and Docker. The same browser is embedded
inside the `file-manager` window node on the canvas. Connect a
`filesystem-target` to it and you're browsing the matching backend.

## Layout

```
app/(filemanager)/files/
├── file-browser.tsx              # the React component (used standalone and inside nodes)
├── filemanager-provider.tsx      # context that exposes upload/download/list/etc.
├── types.ts                      # StorageConnection, FileEntry, *Params
└── server/
    ├── actions.ts                # 'use server', dispatches to the matching backend
    ├── connection-actions.ts     # CRUD on saved StorageConnection rows in Setting
    ├── storage-s3.ts
    ├── storage-ssh.ts
    ├── storage-wsl.ts
    └── storage-docker.ts
```

There is no `/api/files/upload` route any more. Every operation goes
through Next.js server actions. Upload payloads are base64-encoded strings
on the wire.

## Storage backends

Defined in [types.ts](../%28filemanager%29/files/types.ts):

```ts
type StorageType = 's3' | 'ssh' | 'wsl' | 'docker';

interface StorageConnection {
  id: string;
  name: string;
  type: StorageType;
  config: S3Config | SshConfig | WslConfig | DockerConfig;
}
```

Each backend implements the same six functions:

| Function | Signature |
| --- | --- |
| `listFiles(config, path)` | `→ FileEntry[]` |
| `downloadFile(config, path)` | `→ string` (base64) |
| `uploadFile(config, path, data, filename)` | `→ void` |
| `deleteFile(config, path)` | `→ void` |
| `renameFile(config, oldPath, newPath)` | `→ void` |
| `createDirectory(config, path)` | `→ void` |

The dispatch layer in [server/actions.ts](../%28filemanager%29/files/server/actions.ts)
builds a thin facade for the connection's `type` field and forwards every
call.

### S3

[storage-s3.ts](../%28filemanager%29/files/server/storage-s3.ts) uses
`@aws-sdk/client-s3`. Listing is `ListObjectsV2` with `Delimiter: '/'` and
the path as `Prefix`. Upload uses `@aws-sdk/lib-storage`'s `Upload` with
5 MB multipart chunks. `S3Config`:

```ts
{ endpoint, region, bucket, accessKeyId, secretAccessKey }
```

Note that the current upload action accepts the file data as a base64
string. For very large files this is the bottleneck. A future revision
could wire in a streaming endpoint for S3 specifically, since the SDK
already supports `ReadableStream` inputs.

### SSH (SFTP)

[storage-ssh.ts](../%28filemanager%29/files/server/storage-ssh.ts) uses
`ssh2`'s SFTP subsystem. `SshConfig`:

```ts
{ host, port, username, password?, privateKey?, basePath }
```

`basePath` is prepended to every path so a connection can be scoped to a
subtree.

### WSL

[storage-wsl.ts](../%28filemanager%29/files/server/storage-wsl.ts) shells out
to `wsl.exe -d <distro> --exec <command>`. `WslConfig`:

```ts
{ distro, basePath }
```

### Docker

[storage-docker.ts](../%28filemanager%29/files/server/storage-docker.ts)
uses `docker exec` and `docker cp` against a target container.
`DockerConfig`:

```ts
{ containerId, basePath, context? }
```

`context` is the Docker context name used to switch daemons (e.g. for
remote-over-SSH Docker).

## Connection management

`StorageConnection`s are persisted in the `Setting` table:

| Setting id | Value |
| --- | --- |
| `filemanager-connections` | `{ ids: string[] }` (ordering only) |
| `filemanager-connection:<id>` | `StorageConnection` |

`connection-actions.ts` exposes `getConnections`, `saveConnection`,
`deleteConnection`. There's no migration logic. Saved connections survive
across runs because they're rows in SQLite.

## React provider

[`filemanager-provider.tsx`](../%28filemanager%29/files/filemanager-provider.tsx)
wraps the file-browser tree. It exposes `useFileManager()` returning:

- The current path and `FileEntry` list, plus loading state.
- `navigate(path)`, `refresh()`, `goUp()`.
- `upload(files)`, `download(path)`, `rename(oldPath, newPath)`,
  `delete(path)`, `mkdir(name)`.
- `uploads: UploadEntry[]`, per-file progress queue.

The provider is mounted at the root of the app (`PluginProvider` in
[components/core/providers/plugin-provider.tsx](../../components/core/providers/plugin-provider.tsx))
so deeply-nested components (including extensions) can call
`useFileManager()` without explicit prop drilling.

## Inside a node

The built-in `file-manager` window node consumes a `filesystem-target`
input. It builds a `StorageConnection` from the resolved value
(`{ type: 'local' | 'wsl' | 'ssh' }` shape from
[`exposeOutput`](contexts.md)) and renders `<FileBrowser>` inside its own
`FileManagerProvider` instance. That keeps each window's path / upload
queue independent of every other window's.

## File browser UX

`file-browser.tsx`:

- Drag-and-drop upload (folders included; `collectEntries` walks the
  `FileSystemDirectoryEntry` tree synchronously, then reads files in
  parallel).
- Right-click context menu: Rename, Delete, Download.
- Keyboard `↑` to go up, `Enter` to enter folder, `Backspace` to go up.
- Loading indicators per upload (the `UploadEntry` has `progress` and
  `status: 'pending' | 'uploading' | 'done' | 'error'`).
- Path breadcrumb at the top of the panel.
