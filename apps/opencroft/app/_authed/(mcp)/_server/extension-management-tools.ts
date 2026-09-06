/**
 * The extension family: local extension CRUD and compile, install/update/remove of
 * fetched extensions, the shared-folder write lease, and registry search/install.
 */

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import {
  type InstallAuth,
  installExtensionFromUrl,
  uninstallExtension,
  updateInstalledExtension,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import {
  compileLocalExtensionImpl,
  createLocalExtensionImpl,
  deleteLocalExtensionImpl,
  getLocalExtensionImpl,
  listLocalExtensionsImpl,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions-impl'
import { COMPILE_OVERRIDE_PARAM } from '@/app/_authed/(extension-runtime)/_server/checkout-state'
import {
  claimExtensionLease,
  leaseRefusalMessage,
  readActiveLeases,
  releaseExtensionLease,
} from '@/app/_authed/(extension-runtime)/_server/extension-lease'
import { resolveExtensionRepo, searchRegistries } from '@/app/_authed/(extension-runtime)/_server/registry'
import type { ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import {
  claimSlugForWrite,
  fail,
  isValidLocalExtensionSlug,
  LEASE_TOOL_NAME,
  LOCAL_EXTENSION_HANDLE_NODE_ID,
  requireCallingAgent,
  textResult,
} from '@/app/_authed/(mcp)/_server/tool-shared'
import { toastStore } from '@/lib/toast-store'

export const definitions = [
  {
    name: 'list_extensions',
    description:
      'List all local extensions as lightweight summaries (id, name, version, description, node/file counts, target). Use get_extension for the full manifest and source file list. Each extension is a folder under data/extensions/local/<slug>/ containing extension.json and source files — read and edit those files with the remote_* tools (remote_read/remote_write/remote_edit/remote_exec/remote_script) against the static handle given as `target` (format "extensions/<slug>"); paths passed to those tools are relative to the extension folder. Built-in extensions are bundled with the app and not listed here.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_extension',
    description:
      'Get a single local extension by its id (e.g. "local/my-node"). Returns the parsed manifest, the list of source file paths, and a `target` field ("extensions/<slug>"). Read and edit file contents with the remote_* tools (remote_read/remote_write/remote_edit/remote_exec/remote_script) against that target — paths are relative to the extension folder.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The local extension id (must start with "local/")' },
      },
      required: ['extensionId'],
    },
  },
  {
    name: 'create_extension',
    description:
      'Create a new local extension on disk. Writes files under data/extensions/local/<slug>/. At minimum must include extension.json and src/client.tsx. The manifest.id must be "local/<slug>" and match the slug used in the folder. Client source must use `export default defineExtension({ manifest: { id }, nodes: [...] })` from "@ext/host".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: {
          type: 'object',
          description:
            'Map of relative file paths to content. Keys are paths relative to the extension folder (e.g. "extension.json", "src/client.tsx", "server/index.ts", "src/nodes/helper.ts"). At minimum must include "extension.json" and "src/client.tsx".',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'delete_extension',
    description:
      'Uninstall a local extension by removing its folder under data/extensions/local/. Nodes on the canvas that reference its typeId will render as "Unknown extension" until refreshed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The local extension id to delete (must start with "local/")' },
      },
      required: ['extensionId'],
    },
  },
  {
    name: 'compile_extension',
    description:
      'Manually trigger compilation (esbuild) of a local extension. Returns build result with errors and warnings. Useful after direct file edits (e.g. docker cp) that bypass the normal update flow. Compiling publishes the folder to THIS running instance as it stands, so it is declined when the checkout has uncommitted changes or sits on a branch other than its default — pass allowUnclean to do it anyway.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The local extension id (must start with "local/")' },
        [COMPILE_OVERRIDE_PARAM]: {
          type: 'boolean',
          description:
            'Compile the folder in whatever state it is in, including uncommitted changes or a non-default branch. Use deliberately: whatever is on disk becomes what this instance runs.',
        },
      },
      required: ['extensionId'],
    },
  },
  {
    name: LEASE_TOOL_NAME,
    description:
      'See or change who is currently working in a local extension folder. Those folders are shared — every session editing one extension edits the same files — so a write claims the folder for its caller and other callers are told rather than silently writing over it. Call with no arguments to list active claims; with extensionId to take one over or release your own. Claims lapse on their own after a period with no writes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The local extension id (must start with "local/")' },
        takeover: {
          type: 'boolean',
          description: 'Take the folder even though someone else holds it. Always permitted — this is advisory.',
        },
        release: { type: 'boolean', description: 'Give up a claim you hold, so nobody has to wait for it to lapse.' },
      },
    },
  },
  {
    name: 'extension_install',
    description:
      'Install an extension from a public Git repository (GitHub, GitLab, Gitea, Bitbucket, any git remote). Clones at the latest tag by default (falls back to default branch HEAD if no tags). Runs `npm install` if the repo has a package.json. Stored under data/extensions/installed/<slug>/. Resulting id is "installed/<slug>" — unless asLocal is set, which stores it under data/extensions/local/<slug>/ as "local/<slug>" (live-editable, managed like any local extension: compile_extension, delete_extension).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description:
            'Repository: "owner/repo" (assumes github.com) or full URL (e.g. https://gitlab.com/group/repo).',
        },
        ref: {
          type: 'string',
          description: 'Optional tag or branch to install. Defaults to latest semver tag, or default branch HEAD.',
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
            'Clone as a local, live-editable extension (data/extensions/local/<slug>/, id "local/<slug>") instead of the default data/extensions/installed/<slug>/. Not managed by extension_update/extension_remove afterward — use compile_extension/delete_extension instead.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'extension_update',
    description:
      'Re-install an installed extension at a new (or same) ref. Pulls the latest tag from the remote unless a ref is given. Reuses the auth originally configured at install time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The installed extension id (must start with "installed/").' },
        ref: {
          type: 'string',
          description: 'Optional tag or branch. Defaults to the latest semver tag from the remote.',
        },
      },
      required: ['extensionId'],
    },
  },
  {
    name: 'extension_remove',
    description:
      'Uninstall an installed extension. Removes the entire data/extensions/installed/<slug>/ folder including source, sidecar, and bundle. Cannot be undone — re-install via extension_install to restore.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The installed extension id (must start with "installed/").' },
      },
      required: ['extensionId'],
    },
  },

  // ── Registry ─────────────────────────────────────────────────────
  {
    name: 'registry_list',
    description:
      'List extensions from all connected extension registries. Registries are Git repos with a registry.json file listing available extensions.',
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
      'Install an extension by its registry ID. Resolves the repository URL from connected registries, then installs it. Use registry_list to discover available extensions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: {
          type: 'string',
          description: 'Extension ID from the registry (e.g. "opencroft/demo-extension").',
        },
        ref: { type: 'string', description: 'Optional tag or branch to install. Defaults to latest semver tag.' },
      },
      required: ['extensionId'],
    },
  },
  {
    name: 'registry_uninstall',
    description:
      'Uninstall a previously installed extension that was installed from a registry. Removes the extension folder and clears caches.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The installed extension id (must start with "installed/").' },
      },
      required: ['extensionId'],
    },
  },
]

function broadcastExtensionsUpdated(): void {
  toastStore.broadcast({ type: 'extensions_updated' })
}

/** The slug in a local extension id, or null for any other scope or a malformed one. */
export function localSlugFromExtensionId(extensionId: unknown): string | null {
  if (typeof extensionId !== 'string') {
    return null
  }
  const [scope, slug] = extensionId.split('/')
  if (scope !== 'local' || !slug || !isValidLocalExtensionSlug(slug)) {
    return null
  }
  return slug
}

export const handlers: Record<string, ToolHandler> = {
  // ── list_extensions ─────────────────────────────────────────────
  list_extensions: async () => {
    const records = await listLocalExtensionsImpl()
    // Identity + counts only. Use get_extension for the manifest and source file list; read/edit
    // file contents via the remote_* tools against `target`.
    const summaries = records.map((record) => ({
      id: record.id,
      name: record.manifest.name,
      version: record.manifest.version,
      description: record.manifest.description,
      nodeCount: record.manifest.nodes?.length ?? 0,
      fileCount: Object.keys(record.files).length,
      updatedAt: record.updatedAt,
      sourceCommit: record.sourceCommit,
      sourceDirty: record.sourceDirty,
      target: `${LOCAL_EXTENSION_HANDLE_NODE_ID}/${record.slug}`,
    }))
    return textResult(JSON.stringify(summaries, null, 2))
  },

  // ── get_extension ───────────────────────────────────────────────
  get_extension: async (args) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    const record = await getLocalExtensionImpl(extensionId)
    if (!record) {
      fail(-32602, `Extension not found: ${extensionId}`)
    }
    // Manifest + file paths only. Read/edit file contents via the remote_* tools against `target`.
    const { files, ...rest } = record
    return textResult(
      JSON.stringify(
        { ...rest, files: Object.keys(files), target: `${LOCAL_EXTENSION_HANDLE_NODE_ID}/${record.slug}` },
        null,
        2,
      ),
    )
  },

  // ── create_extension ────────────────────────────────────────────
  create_extension: withApprovalRequired(async (args) => {
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
    const record = await createLocalExtensionImpl(files)
    broadcastExtensionsUpdated()
    return textResult(`Extension ${record.id} installed with ${Object.keys(files).length} files.`)
  }),

  // ── delete_extension ───────────────────�����────────────────────────
  delete_extension: withApprovalRequired(async (args) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    await deleteLocalExtensionImpl(extensionId)
    broadcastExtensionsUpdated()
    return textResult(`Extension ${extensionId} uninstalled.`)
  }),

  // ── extension_install ────────────────────────────────────────────
  extension_install: withApprovalRequired(async (args) => {
    const url = args.url as string | undefined
    if (!url) {
      fail(-32602, 'Missing required param: url')
    }
    const ref = args.ref as string | undefined
    const asLocal = args.asLocal === true
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
    const record = await installExtensionFromUrl({ data: { url, ref, auth, asLocal } })
    broadcastExtensionsUpdated()
    return textResult(`Installed ${record.id} at ${record.sidecar.ref} from ${record.sidecar.source.url}.`)
  }),

  // ── extension_update ─────────────────────────────────────────────
  extension_update: withApprovalRequired(async (args) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    const ref = args.ref as string | undefined
    const record = await updateInstalledExtension({ data: { extensionId, ref } })
    broadcastExtensionsUpdated()
    return textResult(`Updated ${record.id} to ${record.sidecar.ref}.`)
  }),

  // ── extension_remove ─────────────────────────────────────────────
  extension_remove: withApprovalRequired(async (args) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    await uninstallExtension({ data: extensionId })
    broadcastExtensionsUpdated()
    return textResult(`Uninstalled ${extensionId}.`)
  }),

  // ── compile_extension ────────────────────────────────────────────
  compile_extension: withApprovalRequired(async (args, caller) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    // Compiling publishes the folder to this instance, so it is a write to
    // the shared thing even when no file changes.
    const compileSlug = localSlugFromExtensionId(extensionId)
    if (compileSlug) {
      await claimSlugForWrite(compileSlug, caller)
    }
    try {
      const result = await compileLocalExtensionImpl(extensionId, {
        allowUnclean: args[COMPILE_OVERRIDE_PARAM] === true,
      })
      if (result.refusal) {
        return textResult(result.refusal.message)
      }
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

  // ── extension_lease ──────────────────────────────────────────────
  [LEASE_TOOL_NAME]: async (args, caller) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      const active = await readActiveLeases()
      const lines = Object.entries(active).map(
        ([slug, lease]) =>
          `local/${slug} — held by ${lease.agent}, last write ${Math.max(0, Math.round((Date.now() - lease.lastTouched) / 60_000))} min ago`,
      )
      return textResult(lines.length > 0 ? lines.join('\n') : 'No extension folders are currently claimed.')
    }
    const slug = localSlugFromExtensionId(extensionId)
    if (!slug) {
      fail(-32602, `Expected a local extension id ("local/<slug>"), got "${extensionId}"`)
    }
    // Taking or releasing a folder is done AS someone: an unattributable
    // claim would name a holder nobody can be asked about.
    const agent = requireCallingAgent(caller)
    if (args.release === true) {
      const released = await releaseExtensionLease(slug, agent)
      return textResult(
        released ? `Released local/${slug}.` : `local/${slug} was not held by you — nothing to release.`,
      )
    }
    const decision = await claimExtensionLease(slug, agent, { takeover: args.takeover === true })
    if (decision.outcome === 'refused') {
      return textResult(
        leaseRefusalMessage(slug, decision.lease, Date.now(), `call ${LEASE_TOOL_NAME} with takeover: true`),
      )
    }
    return textResult(`local/${slug} is yours (${decision.outcome}).`)
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
    const ref = args.ref as string | undefined
    const resolved = await resolveExtensionRepo({ id: extensionId })
    if (!resolved) {
      return textResult(`Extension "${extensionId}" not found in any connected registry.`)
    }
    const record = await installExtensionFromUrl({ data: { url: resolved.repository, ref, auth: resolved.auth } })
    broadcastExtensionsUpdated()
    return textResult(
      `Installed ${record.manifest.name ?? record.id} (${record.sidecar.ref}) from ${resolved.repository}`,
    )
  }),

  // ── registry_uninstall ──────────────────────────────────────────
  registry_uninstall: withApprovalRequired(async (args) => {
    const extensionId = args.extensionId as string | undefined
    if (!extensionId) {
      fail(-32602, 'Missing required param: extensionId')
    }
    await uninstallExtension({ data: extensionId })
    broadcastExtensionsUpdated()
    return textResult(`Uninstalled ${extensionId}.`)
  }),
}
