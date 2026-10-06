/**
 * The extension family: local extension CRUD and compile, install/update/remove of
 * fetched extensions, the folder write lock, and registry search/install.
 *
 * Tools that act on an extension's files take its folder under `extensions/`
 * (`extensionFolder`); tools that install take a source. An extension folder is
 * `<owner>.<extension>`; local ones (`local.<name>`) are the editable ones.
 */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import {
  compileLocalExtensionImpl,
  createLocalExtensionImpl,
  deleteLocalExtensionImpl,
  getLocalExtensionImpl,
  listLocalExtensionsImpl,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions-impl'
import { isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  claimExtensionLock,
  extensionLockRefusalMessage,
  readActiveExtensionLocks,
  releaseExtensionLock,
} from '@/app/_authed/(extension-runtime)/_server/extension-lock'
import type { ExtensionRow, InstallAuth } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import {
  installFromRegistry,
  installFromUrl,
  uninstallExtension,
  updateExtension,
} from '@/app/_authed/(extension-runtime)/_server/install'
import { searchRegistries } from '@/app/_authed/(extension-runtime)/_server/registry'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import {
  claimFolderForWrite,
  fail,
  jsonResult,
  LOCAL_EXTENSION_HANDLE_NODE_ID,
  LOCK_TOOL_NAME,
  requireCallingAgent,
  textResult,
} from '@/app/_authed/(mcp)/_server/tool-shared'
import { agentRefName } from '@/app/_authed/(space)/_server/agents-impl'
import { toastStore } from '@/lib/toast-store'

const LOCAL_FOLDER_PARAM = {
  extensionFolder: {
    type: 'string',
    description: 'The local extension folder, "local.<name>" — see list_extensions.',
  },
}

const INSTALLED_FOLDER_PARAM = {
  extensionFolder: {
    type: 'string',
    description: 'The extension folder under extensions/, "<owner>.<extension>" (for an install, its extension id).',
  },
}

export const definitions = [
  {
    name: 'list_extensions',
    description:
      'List the local extensions — the editable ones, each a folder "local.<name>" under the extensions folder — as lightweight summaries: folder, the extension id it runs under, name, version, description, node/file counts and a `target`. A local folder whose manifest names another extension\'s id (e.g. "acme.widgets") is a development copy that stands in for that extension. Use get_extension for the full manifest and source file list. Read and edit the files with the remote_* tools (remote_read/remote_write/remote_edit/remote_exec/remote_script) against `target` ("extensions/<folder>"); paths are relative to the extension folder. Built-in and installed extensions are not listed here.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_extension',
    description:
      'Get one local extension by its folder (e.g. "local.my-node"). Returns the parsed manifest, the extension id it runs under, the list of source file paths, and a `target` field ("extensions/<folder>"). Read and edit file contents with the remote_* tools against that target — paths are relative to the extension folder.',
    inputSchema: { type: 'object' as const, properties: LOCAL_FOLDER_PARAM, required: ['extensionFolder'] },
  },
  {
    name: 'create_extension',
    description:
      'Create a new local extension in the folder "local.<name>". At minimum `files` must include extension.json and src/client.tsx. The manifest needs no `id`: the extension runs under its folder name. Client source must use `export default defineExtension({ manifest: { name }, nodes: [...] })`, taking `defineExtension` and the rest of the client surface from the `legacy` namespace of "@opencroft/client" — that spelling is the one carrying type declarations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCAL_FOLDER_PARAM,
        files: {
          type: 'object',
          description:
            'Map of relative file paths to content. Keys are paths relative to the extension folder (e.g. "extension.json", "src/client.tsx", "server/index.ts", "src/nodes/helper.ts"). At minimum must include "extension.json" and "src/client.tsx".',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['extensionFolder', 'files'],
    },
  },
  {
    name: 'delete_extension',
    description:
      'Delete a local extension: its folder, then its record. Nodes and apps using its types are kept and show as belonging to a missing extension; if it was a development copy standing in for an installed extension, that installed one comes back into effect.',
    inputSchema: { type: 'object' as const, properties: LOCAL_FOLDER_PARAM, required: ['extensionFolder'] },
  },
  {
    name: 'compile_extension',
    description:
      'Manually trigger compilation (esbuild) of a local extension. Returns build result with errors and warnings. Useful after direct file edits (e.g. docker cp) that bypass the normal update flow. Compiling publishes the folder to THIS running instance as it stands, uncommitted changes included.',
    inputSchema: { type: 'object' as const, properties: LOCAL_FOLDER_PARAM, required: ['extensionFolder'] },
  },
  {
    name: LOCK_TOOL_NAME,
    description:
      'See or change who holds the lock on a local extension folder. Those folders are shared — every session editing one extension edits the same files — so a write locks the folder for its caller and other callers are told rather than silently writing over it. Call with no arguments to list active locks; with extensionFolder to take one over or release your own. Locks lapse on their own after a period with no writes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCAL_FOLDER_PARAM,
        takeover: {
          type: 'boolean',
          description: 'Take the folder even though someone else holds it. Always permitted — the lock is advisory.',
        },
        release: { type: 'boolean', description: 'Give up a lock you hold, so nobody has to wait for it to lapse.' },
      },
    },
  },
  {
    name: 'extension_install',
    description:
      'Install an extension from a Git repository (GitHub, GitLab, Gitea, Bitbucket, any git remote): a snapshot of one commit, without .git, read-only on this instance. Installs the latest version tag by default (the default branch when there are none) into the folder "<owner>.<repo>" taken from the URL, which is also its extension id; a URL whose path is not exactly owner/repo needs `id`. With asLocal it is instead a full git checkout in "local.<repo>" — editable, compiled with compile_extension, updated by pulling — that stands in for the extension its manifest names.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'Repository: "owner/repo" (assumes github.com) or full URL (e.g. https://gitlab.com/group/repo).',
        },
        id: {
          type: 'string',
          description:
            'The extension id to install under, "<owner>.<extension>". Required when the URL path has more than two segments.',
        },
        ref: {
          type: 'string',
          description: 'Optional tag or branch to install. Defaults to the latest version tag, or the default branch.',
        },
        auth: {
          type: 'object',
          description:
            'Optional auth for private repos. Pulls "token" (required) and "username" (optional, defaults to x-access-token) from the named Secrets Store.',
          properties: {
            storeId: { type: 'string', description: 'Secrets Store node id holding the credentials.' },
            tokenKey: { type: 'string', description: 'Secret key for the token. Defaults to "token".' },
            usernameKey: { type: 'string', description: 'Secret key for the username. Defaults to "username".' },
          },
          required: ['storeId'],
        },
        asLocal: {
          type: 'boolean',
          description:
            'Install as a local extension: a full git checkout in "local.<repo>", editable and managed with compile_extension/delete_extension.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'extension_update',
    description:
      'Re-install an installed extension from its source at a new (or the same) ref, replacing its folder only once the new one has built. Defaults to the latest version tag. Reuses the auth recorded at install time. A local extension is updated by pulling instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...INSTALLED_FOLDER_PARAM,
        ref: { type: 'string', description: 'Optional tag or branch. Defaults to the latest version tag.' },
      },
      required: ['extensionFolder'],
    },
  },
  {
    name: 'extension_remove',
    description:
      'Uninstall an extension: removes its folder, then its record. Nodes and apps using its types are kept and show as belonging to a missing extension. Re-install to restore.',
    inputSchema: { type: 'object' as const, properties: INSTALLED_FOLDER_PARAM, required: ['extensionFolder'] },
  },

  // ── Registry ─────────────────────────────────────────────────────
  {
    name: 'registry_list',
    description:
      'List extensions from all connected extension registries. Registries are Git repos with a registry.json file listing available extensions by id ("<owner>.<extension>").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Optional search query to filter extensions by name, description, author, or tags.',
        },
      },
    },
  },
  {
    name: 'registry_install',
    description:
      'Install an extension by its registry id into the folder of that id. Use registry_list to discover available extensions. With asLocal it is a development checkout in "local.<extension>" instead, standing in for the registry extension.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: {
          type: 'string',
          description: 'Extension id from the registry (e.g. "acme.demo-extension").',
        },
        ref: { type: 'string', description: 'Optional tag or branch to install. Defaults to the latest version tag.' },
        asLocal: {
          type: 'boolean',
          description: 'Install as an editable development checkout in "local.<extension>".',
        },
      },
      required: ['extensionId'],
    },
  },
  {
    name: 'registry_uninstall',
    description: 'Uninstall an extension installed from a registry: removes its folder, then its record.',
    inputSchema: { type: 'object' as const, properties: INSTALLED_FOLDER_PARAM, required: ['extensionFolder'] },
  },
]

function broadcastExtensionsUpdated(): void {
  toastStore.broadcast({ type: 'extensions_updated' })
}

function requireFolder(args: Record<string, unknown>): string {
  const folder = args.extensionFolder
  if (typeof folder !== 'string' || !folder) {
    fail(-32602, 'Missing required param: extensionFolder')
  }
  return folder
}

/** A local folder from the arguments, or a refusal: only local folders are editable. */
function requireLocalFolder(args: Record<string, unknown>): string {
  const folder = requireFolder(args)
  if (!isLocalFolder(folder)) {
    fail(-32602, `Expected a local extension folder ("local.<name>"), got "${folder}"`)
  }
  return folder
}

function installedLine(row: ExtensionRow): string {
  return `Installed ${row.folder} at ${row.ref ?? 'HEAD'} (${row.commit?.slice(0, 12) ?? 'unknown commit'}) from ${row.sourceUrl}.`
}

export const handlers: Record<string, ToolHandler> = {
  // ── list_extensions ─────────────────────────────────────────────
  list_extensions: async () => {
    const records = await listLocalExtensionsImpl()
    // Identity + counts only. Use get_extension for the manifest and source file list; read/edit
    // file contents via the remote_* tools against `target`.
    const summaries = records.map((record) => ({
      folder: record.folder,
      id: record.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description,
      nodeCount: record.manifest.nodes?.length ?? 0,
      fileCount: Object.keys(record.files).length,
      updatedAt: record.updatedAt,
      sourceCommit: record.sourceCommit,
      sourceDirty: record.sourceDirty,
      target: `${LOCAL_EXTENSION_HANDLE_NODE_ID}/${record.folder}`,
    }))
    return jsonResult(summaries)
  },

  // ── get_extension ───────────────────────────────────────────────
  get_extension: async (args) => {
    const folder = requireLocalFolder(args)
    const record = await getLocalExtensionImpl(folder)
    if (!record) {
      fail(-32602, `Extension not found: ${folder}`)
    }
    // Manifest + file paths only. Read/edit file contents via the remote_* tools against `target`.
    const { files, ...rest } = record
    return jsonResult({
      ...rest,
      files: Object.keys(files),
      target: `${LOCAL_EXTENSION_HANDLE_NODE_ID}/${record.folder}`,
    })
  },

  // ── create_extension ────────────────────────────────────────────
  create_extension: withApprovalRequired(async (args) => {
    const folder = requireLocalFolder(args)
    const filesRaw = args.files as Record<string, unknown> | undefined
    if (!filesRaw || typeof filesRaw !== 'object') {
      fail(-32602, 'Missing required param: files')
    }
    const files: Record<string, string> = {}
    for (const [k, v] of Object.entries(filesRaw)) {
      if (typeof k !== 'string' || typeof v !== 'string') {
        fail(-32602, `Invalid file entry: ${k}`)
      }
      files[k] = v
    }
    if (!files['extension.json']) {
      fail(-32602, 'files must include "extension.json"')
    }
    const record = await createLocalExtensionImpl(folder, files)
    broadcastExtensionsUpdated()
    return textResult(`Extension ${record.folder} (id ${record.id}) created with ${Object.keys(files).length} files.`)
  }),

  // ── delete_extension ────────────────────────────────────────────
  delete_extension: withApprovalRequired(async (args) => {
    const folder = requireLocalFolder(args)
    await deleteLocalExtensionImpl(folder)
    broadcastExtensionsUpdated()
    return textResult(`Extension ${folder} deleted.`)
  }),

  // ── extension_install ────────────────────────────────────────────
  extension_install: withApprovalRequired(async (args) => {
    const url = args.url as string | undefined
    if (!url) {
      fail(-32602, 'Missing required param: url')
    }
    const authRaw = args.auth as { storeId?: string; tokenKey?: string; usernameKey?: string } | undefined
    let auth: InstallAuth | undefined
    if (authRaw) {
      if (!authRaw.storeId) {
        fail(-32602, 'auth.storeId is required when auth is provided')
      }
      auth = {
        type: 'secret',
        storeId: authRaw.storeId,
        tokenKey: authRaw.tokenKey,
        usernameKey: authRaw.usernameKey,
      }
    }
    const row = await installFromUrl({
      url,
      id: args.id as string | undefined,
      ref: args.ref as string | undefined,
      auth,
      asLocal: args.asLocal === true,
    })
    return textResult(installedLine(row))
  }),

  // ── extension_update ─────────────────────────────────────────────
  extension_update: withApprovalRequired(async (args) => {
    const folder = requireFolder(args)
    const row = await updateExtension(folder, args.ref as string | undefined)
    return textResult(
      `Updated ${row.folder} to ${row.ref ?? 'HEAD'} (${row.commit?.slice(0, 12) ?? 'unknown commit'}).`,
    )
  }),

  // ── extension_remove ─────────────────────────────────────────────
  extension_remove: withApprovalRequired(async (args) => {
    const folder = requireFolder(args)
    await uninstallExtension(folder)
    return textResult(`Uninstalled ${folder}.`)
  }),

  // ── compile_extension ────────────────────────────────────────────
  compile_extension: withApprovalRequired(async (args, caller) => {
    const folder = requireLocalFolder(args)
    // Compiling publishes the folder to this instance, so it is a write to
    // the shared thing even when no file changes.
    await claimFolderForWrite(folder, caller)
    try {
      const result = await compileLocalExtensionImpl(folder)
      const parts: string[] = []
      parts.push(`Build ${result.success ? '✅ succeeded' : '❌ failed'}`)
      if (result.errors.length > 0) {
        parts.push(`\nErrors (${result.errors.length}):`)
        for (const e of result.errors) {
          const loc = e.line ? `${e.file}:${e.line}:${e.column}` : e.file
          parts.push(`  ${loc}: ${e.message}`)
        }
      }
      if (result.warnings.length > 0) {
        parts.push(`\nWarnings (${result.warnings.length}):`)
        for (const w of result.warnings) {
          const loc = w.line ? `${w.file}:${w.line}:${w.column}` : w.file
          parts.push(`  ${loc}: ${w.message}`)
        }
      }
      if (result.success) {
        broadcastExtensionsUpdated()
      }
      return textResult(parts.join('\n'))
    } catch (err) {
      return textResult(`Compilation error: ${String(err)}`)
    }
  }),

  // ── extension_lock ───────────────────────────────────────────────
  [LOCK_TOOL_NAME]: async (args, caller) => {
    if (args.extensionFolder === undefined) {
      const active = await readActiveExtensionLocks()
      const lines = Object.entries(active).map(
        ([folder, lock]) =>
          `${folder} — locked by ${lock.agent}, last write ${Math.max(0, Math.round((Date.now() - lock.lastTouched) / 60_000))} min ago`,
      )
      return textResult(lines.length > 0 ? lines.join('\n') : 'No extension folders are currently locked.')
    }
    const folder = requireLocalFolder(args)
    // Taking or releasing a lock is done AS someone: an unattributable lock
    // would name a holder nobody can be asked about. Locks are held under a
    // name, because a name is what the next agent to hit the folder is told
    // to go and ask.
    const agent = agentRefName(requireCallingAgent(caller))
    if (args.release === true) {
      const released = await releaseExtensionLock(folder, agent)
      return textResult(released ? `Released ${folder}.` : `${folder} was not locked by you — nothing to release.`)
    }
    const decision = await claimExtensionLock(folder, agent, { takeover: args.takeover === true })
    if (decision.outcome === 'refused') {
      return textResult(
        extensionLockRefusalMessage(folder, decision.lock, Date.now(), `call ${LOCK_TOOL_NAME} with takeover: true`),
      )
    }
    return textResult(`${folder} is locked by you (${decision.outcome}).`)
  },

  // ── registry_list ────────────────────────────────────────────────
  registry_list: async (args) => {
    const query = args.query as string | undefined
    const results = await searchRegistries(query || undefined)
    if (results.length === 0) {
      return textResult('No extensions found in connected registries.')
    }
    const lines = results.map((ext) => {
      const parts = [`**${ext.name}** (${ext.id})`]
      if (ext.description) {
        parts.push(`  ${ext.description}`)
      }
      parts.push(`  Repository: ${ext.repository}`)
      if (ext.author) {
        parts.push(`  Author: ${ext.author}`)
      }
      parts.push(`  Registry: ${ext.registryName}`)
      return parts.join('\n')
    })
    return textResult(`Found ${results.length} extension(s):\n\n${lines.join('\n\n')}`)
  },

  // ── registry_install ─────────────────────────────────────────────
  registry_install: withApprovalRequired(async (args) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    const row = await installFromRegistry(extensionId, {
      ref: args.ref as string | undefined,
      asLocal: args.asLocal === true,
    })
    return textResult(installedLine(row))
  }),

  // ── registry_uninstall ──────────────────────────────────────────
  registry_uninstall: withApprovalRequired(async (args) => {
    const folder = requireFolder(args)
    await uninstallExtension(folder)
    return textResult(`Uninstalled ${folder}.`)
  }),
}
