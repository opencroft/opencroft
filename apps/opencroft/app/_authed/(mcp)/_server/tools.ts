/**
 * MCP tool definitions and handlers for the App Dashboard.
 *
 * Graph tools are scoped by `space` (slug).
 * If omitted, the active space is used. Extension tools operate on v2
 * local extensions (folders under `data/extensions/local/<slug>/`). Source files are read and
 * edited via the remote_* tools (remote_read/remote_write/remote_edit/remote_exec/remote_script)
 * against the static handle "extensions/<slug>" — see `resolveLocalExtensionContext` — rather
 * than a dedicated per-file extension tool.
 * UI feedback (toasts, focus, comments) is broadcast via SSE.
 */

import path from 'node:path'

import { checkMcpServer } from 'agent-client/mcp-check'
import type { KeyValue, McpServerConfig, McpTransport } from 'agent-client/mcp-types'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { isConnectionNodeName, readMcpServers, writeMcpServers } from '@/app/_authed/(agent)/_server/mcp-store'
import {
  ApprovalRejectedError,
  awaitApproval,
  getApprovalMeta,
  withApprovalRequired,
} from '@/app/_authed/(approvals)/_server/with-approval'
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
import { dispatchExecutionContext, NoExecTargetError } from '@/app/_authed/(extension-runtime)/_server/exec-dispatch'
import { getExtensionModule, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import {
  dispatchNodeActionImpl,
  listNodeActionsImpl,
} from '@/app/_authed/(extension-runtime)/_server/node-actions-impl'
import {
  buildNodeTypeHandles,
  expandDynamicHandles,
  findDockerExtensionId,
} from '@/app/_authed/(extension-runtime)/_server/node-handles'
import { localExtRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import { resolveExtensionRepo, searchRegistries } from '@/app/_authed/(extension-runtime)/_server/registry'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { recordAudit } from '@/app/_authed/(mcp)/_server/audit'
import { executeExtensionTool, getExtensionToolDefinitions } from '@/app/_authed/(mcp)/_server/extension-tools'
import { skillToolDefinitions, skillToolHandlers } from '@/app/_authed/(mcp)/_server/skill-tools'
import { isYoloMode } from '@/app/_authed/(mcp)/_server/yolo'
// MCP tool calls carry no session cookie by design (bearer-token surface,
// not cookies), so every space operation reached from here must be the
// plain `*Impl`, never the createServerFn wrapper in actions.ts. The wrappers
// check the session; calling one in-process from a tool throws "Not signed
// in" for a caller that was never supposed to have a session. That is exactly
// what happened when the session gate first landed in the shared
// implementations — it broke the read tools directly, and every graph-write
// tool indirectly through withGraphConflictRetry's default load/save.
import {
  createSpaceImpl,
  deleteSpaceImpl,
  findSpaceByNodeImpl,
  getActiveSpaceSlugImpl,
  listSpacesImpl,
  loadSpaceGraphImpl,
  renameSpaceImpl,
} from '@/app/_authed/(space)/_server/actions-impl'
import { withGraphConflictRetry } from '@/app/_authed/(space)/_server/graph-conflict-retry'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { GraphData } from '@/app/_authed/(space)/_server/types'
import { askUserStore } from '@/lib/ask-user-store'
import { toastStore } from '@/lib/toast-store'
import { secrets } from '@/server/secrets'

const SPACE_PARAM = {
  space: {
    type: 'string',
    description: 'Space slug. Omit to target the currently active space.',
  },
}

const POSITION_SCHEMA = {
  type: 'object',
  description: 'Canvas position',
  properties: {
    x: { type: 'number', description: 'X coordinate' },
    y: { type: 'number', description: 'Y coordinate' },
  },
  required: ['x', 'y'],
}

const EDGE_ENDPOINT_DESCRIPTION = 'Node ID, optionally with handle after a slash (e.g. "node-id/out").'

/**
 * Directory names remote_glob/remote_grep skip by default (dependency, VCS and build output
 * folders) — the ripgrep/fd-style default agents expect. Both tools re-include them when the
 * search `path` itself points inside one, or when `includeIgnored` is passed.
 */
export const SEARCH_EXCLUDED_DIRS = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  '__pycache__',
]

const SEARCH_INCLUDE_IGNORED_PARAM = {
  includeIgnored: {
    type: 'boolean',
    description: `Also search normally-skipped directories (${SEARCH_EXCLUDED_DIRS.join(', ')}). Off by default; skipping is auto-disabled when \`path\` itself points inside one of them.`,
  },
}

export const toolDefinitions = [
  // ── Toasts ────────────────────────────────────────────────────────
  {
    name: 'send_toast',
    description: 'Show a toast notification in the OpenCroft browser UI via SSE.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Toast message text' },
        type: {
          type: 'string',
          enum: ['info', 'success', 'warning', 'error'],
          description: 'Toast type (default: "info")',
        },
        ...SPACE_PARAM,
      },
      required: ['message'],
    },
  },

  // ── Spaces ────────────────────────────────────────────────────────
  {
    name: 'list_spaces',
    description: 'List all spaces. Each space is an independent graph.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'create_space',
    description: 'Create a new empty space.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Human-readable name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'rename_space',
    description: 'Rename an existing space.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: { type: 'string', description: 'Space slug' },
        name: { type: 'string', description: 'New name' },
      },
      required: ['space', 'name'],
    },
  },
  {
    name: 'delete_space',
    description: 'Delete a space by slug. The last remaining space cannot be deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        space: { type: 'string', description: 'Space slug' },
      },
      required: ['space'],
    },
  },

  // ── Node CRUD ─────────────────────────────────────────────────────
  {
    name: 'list_nodes',
    description: 'List all nodes in a space. Returns a compact array of `{ id, name }` entries.',
    inputSchema: { type: 'object' as const, properties: { ...SPACE_PARAM } },
  },
  {
    name: 'find_nodes',
    description:
      'Find nodes whose name, type, or data fields match any of the given glob patterns (case-insensitive). Use `*` and `?` wildcards.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        patterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns (e.g. ["*server*", "WSL"]).',
          minItems: 1,
        },
        ...SPACE_PARAM,
      },
      required: ['patterns'],
    },
  },
  {
    name: 'get_nodes',
    description:
      'Get one or more nodes from a space by ID. Returns `{ found: Node[], missing: string[] }`. Each found node includes a `handles: { input, output }` map: `input[handleId]` is `"node-id/handle-id"` for the connected source or `null`, `output[handleId]` is an array of connected target endpoints (empty if unconnected). Dynamic source handles are expanded to live ids (e.g. application nodes expose one `instance-terminal-<containerId>` per running instance).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unique node IDs to fetch.',
          minItems: 1,
        },
        ...SPACE_PARAM,
      },
      required: ['nodeIds'],
    },
  },
  {
    name: 'create_nodes',
    description:
      'Create one or more nodes in a space. Each `type` must match a registered extension typeId (e.g. "server", "docker-service", "application").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Extension typeId' },
              position: POSITION_SCHEMA,
              data: {
                type: 'object',
                description: 'Initial node data (shape depends on the extension)',
                additionalProperties: true,
              },
            },
            required: ['type'],
          },
        },
        ...SPACE_PARAM,
      },
      required: ['nodes'],
    },
  },
  {
    name: 'update_nodes',
    description:
      "Update nodes' data and/or position (shallow merge). For long or multi-line string fields, prefer write_node_property / edit_node_property.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'The unique node ID' },
              data: {
                type: 'object',
                description: "Partial data to merge into the node's data",
                additionalProperties: true,
              },
              position: POSITION_SCHEMA,
            },
            required: ['nodeId'],
          },
        },
        ...SPACE_PARAM,
      },
      required: ['updates'],
    },
  },
  {
    name: 'write_node_property',
    description:
      'Overwrite a string property on a node by dot path (e.g. "script"). Preferred over update_nodes for multi-line strings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'The unique node ID' },
        path: { type: 'string', description: 'Dot path within node.data, e.g. "script".' },
        value: { type: 'string', description: 'New string value.' },
        ...SPACE_PARAM,
      },
      required: ['nodeId', 'path', 'value'],
    },
  },
  {
    name: 'edit_node_property',
    description:
      "Replace an exact string inside a node's string property at a dot path. Preferred over update_nodes for targeted edits in multi-line strings. Fails if oldString is not unique unless replaceAll is true.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'The unique node ID' },
        path: { type: 'string', description: 'Dot path within node.data, e.g. "script".' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        ...SPACE_PARAM,
      },
      required: ['nodeId', 'path', 'oldString', 'newString'],
    },
  },
  {
    name: 'delete_nodes',
    description: 'Delete one or more nodes and all their connected edges.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs to delete.',
        },
        ...SPACE_PARAM,
      },
      required: ['nodeIds'],
    },
  },

  // ── Edge CRUD ─────────────────────────────────────────────────────
  {
    name: 'list_edges',
    description: 'List all edges in a space.',
    inputSchema: { type: 'object' as const, properties: { ...SPACE_PARAM } },
  },
  {
    name: 'connect_nodes',
    description: 'Connect nodes with one or more edges. Source and target handles must share the same contextType.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edges: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: EDGE_ENDPOINT_DESCRIPTION },
              target: { type: 'string', description: EDGE_ENDPOINT_DESCRIPTION },
            },
            required: ['source', 'target'],
          },
        },
        ...SPACE_PARAM,
      },
      required: ['edges'],
    },
  },
  {
    name: 'disconnect_nodes',
    description: 'Remove one or more edges between nodes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        edges: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              source: { type: 'string', description: EDGE_ENDPOINT_DESCRIPTION },
              target: { type: 'string', description: EDGE_ENDPOINT_DESCRIPTION },
            },
            required: ['source', 'target'],
          },
        },
        ...SPACE_PARAM,
      },
      required: ['edges'],
    },
  },

  // ── Focus & Comments ──────────────────────────────────────────────
  {
    name: 'focus_node',
    description:
      'Focus the camera on a node and select it. If the node lives in a different space, the UI switches to it first. If `comment` is provided, also attach a floating comment bubble to the node.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'The node ID to focus on' },
        comment: { type: 'string', description: 'Optional comment to attach to the node.' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'comment_nodes',
    description:
      'Attach floating comment bubbles to one or more nodes. Each node has at most one comment — subsequent calls replace the previous message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        comments: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              nodeId: { type: 'string', description: 'The node ID to attach the comment to' },
              message: { type: 'string', description: 'Comment message text' },
            },
            required: ['nodeId', 'message'],
          },
        },
        ...SPACE_PARAM,
      },
      required: ['comments'],
    },
  },
  {
    name: 'uncomment_nodes',
    description: 'Remove comment bubbles from one or more nodes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Node IDs whose comments should be removed.',
        },
        ...SPACE_PARAM,
      },
      required: ['nodeIds'],
    },
  },

  // ── Local Extensions (multi-file folder-backed) ───────────────────
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
      'Manually trigger compilation (esbuild) of a local extension. Returns build result with errors and warnings. Useful after direct file edits (e.g. docker cp) that bypass the normal update flow.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The local extension id (must start with "local/")' },
      },
      required: ['extensionId'],
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

  // ── Remote File & Exec Ops ──────────────────────────────────────────
  {
    name: 'remote_read',
    description:
      'Read a file from a remote node. The target is a terminal-context output handle in "node-id/handle-id" format (e.g. "localhost_abc/terminal"). Output is line-numbered (cat -n style). Optional offset/limit slice by 1-indexed line.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        path: {
          type: 'string',
          description:
            "Absolute file path on the remote node, or a path relative to the target's working directory when it has one.",
        },
        offset: { type: 'number', description: '1-indexed line to start from. Default 1.' },
        limit: { type: 'number', description: 'Number of lines to return. Default: read to end.' },
      },
      required: ['target', 'path'],
    },
  },
  {
    name: 'remote_glob',
    description:
      'Find file paths by glob on a remote node\'s filesystem (`**` spans directories, `*` doesn\'t, `?` = one char), e.g. "src/**/*.tsx". The target is a terminal-context output handle in "node-id/handle-id" format. Read-only. Returns one matching path per line, relative to `path`. Dependency/VCS/build directories (node_modules, .git, dist, …) are skipped unless `includeIgnored` is set or `path` points inside one. No matches (or a missing `path`) return "(no matches)" rather than an error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        pattern: {
          type: 'string',
          description: 'Glob pattern, e.g. "**/*.tsx" or "src/*.ts".',
        },
        path: {
          type: 'string',
          description:
            "Directory to search from, absolute or relative to the target's working directory. Defaults to the target's working directory.",
        },
        exclude: {
          type: 'string',
          description: 'Drop paths matching this glob, e.g. "**/*.test.ts".',
        },
        ...SEARCH_INCLUDE_IGNORED_PARAM,
        limit: {
          type: 'number',
          description: 'Max number of matching paths to return. Default 200; result notes if truncated.',
        },
      },
      required: ['target', 'pattern'],
    },
  },
  {
    name: 'remote_grep',
    description:
      'Search file contents by regular expression (POSIX extended, i.e. `grep -E`) on a remote node\'s filesystem, recursively under `path`. The target is a terminal-context output handle in "node-id/handle-id" format. Read-only. Returns matching lines as "path:line:text", one per line, with paths echoed in the same form `path` was given (relative when omitted). Dependency/VCS/build directories (node_modules, .git, dist, …) are skipped unless `includeIgnored` is set or `path` points inside one; overlong lines are column-truncated. No matches (or a missing `path`) return "(no matches)" rather than an error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        pattern: {
          type: 'string',
          description: 'POSIX extended regular expression, e.g. "TODO|FIXME".',
        },
        path: {
          type: 'string',
          description:
            "File or directory to search, absolute or relative to the target's working directory. Defaults to the target's working directory.",
        },
        glob: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. "*.ts" (maps to `grep --include`).',
        },
        caseInsensitive: {
          type: 'boolean',
          description: 'Case-insensitive match (`grep -i`).',
        },
        contextLines: {
          type: 'number',
          description: 'Show this many lines of context around each match (`grep -C`).',
        },
        filesOnly: {
          type: 'boolean',
          description: 'Return only the paths of files containing a match (`grep -l`), not the matching lines.',
        },
        ...SEARCH_INCLUDE_IGNORED_PARAM,
        limit: {
          type: 'number',
          description: 'Max number of result lines to return. Default 200; result notes if truncated.',
        },
      },
      required: ['target', 'pattern'],
    },
  },
  {
    name: 'remote_write',
    description:
      'Write or overwrite a file on a remote node. The target is a terminal-context output handle in "node-id/handle-id" format.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        path: {
          type: 'string',
          description:
            "Absolute file path on the remote node, or a path relative to the target's working directory when it has one.",
        },
        content: { type: 'string', description: 'File content to write (UTF-8).' },
      },
      required: ['target', 'path', 'content'],
    },
  },
  {
    name: 'remote_edit',
    description:
      'Replace an exact string in a remote file. Fails if oldString is not unique unless replaceAll is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        path: {
          type: 'string',
          description:
            "Absolute file path on the remote node, or a path relative to the target's working directory when it has one.",
        },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['target', 'path', 'oldString', 'newString'],
    },
  },
  {
    name: 'remote_exec',
    description:
      'Execute a shell command on a remote node. The target is a terminal-context output handle in "node-id/handle-id" format. Optionally inject secret values from any Secrets Store as env vars (reference them in the command via "$NAME").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: {
          type: 'string',
          description:
            "Working directory to run the command in (absolute path, or relative to the target's working directory; defaults to it when omitted).",
        },
        secrets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of secrets (keys in any Secrets Store) to decrypt and inject as env vars before the command runs. Reference them via "$NAME" inside the command. Values are never returned, only injected into the executor process.',
        },
        description: {
          type: 'string',
          description:
            'Short, human-readable description of what the command does (5-10 words). Shown in the permission prompt UI.',
        },
      },
      required: ['target', 'command', 'description'],
    },
  },
  {
    name: 'remote_script',
    description:
      'Execute a multiline bash script on a remote node. Unlike remote_exec, the script body is written to a temp file first, so it avoids quoting/escaping issues with heredocs, loops, and nested quotes. The target is a terminal-context output handle in "node-id/handle-id" format. Optionally inject secret values from any Secrets Store as env vars (reference them in the script via "$NAME").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        script: { type: 'string', description: 'Multiline bash script body to execute.' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Positional arguments passed to the script (available as $1, $2, ... inside it).',
        },
        cwd: {
          type: 'string',
          description:
            "Working directory to run the script in (absolute path, or relative to the target's working directory; defaults to it when omitted).",
        },
        secrets: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of secrets (keys in any Secrets Store) to decrypt and inject as env vars before the script runs. Reference them via "$NAME" inside the script. Values are never returned, only injected into the executor process.',
        },
        description: {
          type: 'string',
          description:
            'Short, human-readable description of what the script does (5-10 words). Shown in the permission prompt UI.',
        },
      },
      required: ['target', 'script', 'description'],
    },
  },

  // ── Node Actions ────────────────────────────────────────────────────
  {
    name: 'list_actions',
    description:
      'List the actions available on a node (e.g. lifecycle actions like deploy/start/stop on a container-backed node, run on a script node). Use this to discover what actions a node exposes before calling them.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'Target node ID.' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'call',
    description:
      'Invoke an action on a node — equivalent to clicking the corresponding button in the UI. Same code path, no duplication. Use list_actions first to discover available action IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'Target node ID.' },
        action: { type: 'string', description: 'Action ID from the node manifest (e.g. "start", "stop", "run").' },
        params: {
          type: 'object',
          description: 'Optional parameters for the action. Shape depends on the action.',
          additionalProperties: true,
        },
      },
      required: ['nodeId', 'action'],
    },
  },

  // ── MCP servers ─────────────────────────────────────────────────────────
  {
    name: 'mcp_list',
    description:
      'List the globally-configured MCP servers available to local agents. Definitions are global (shared by every local agent). Secret values (header/env values and any URL credentials) are redacted.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'mcp_set',
    description:
      'Create or update a global MCP server by name (upsert). Provided fields override the existing entry; omitted fields are preserved. stdio transport requires `command`; http/sse require `url`. Definitions are global.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique server name — the key used for the upsert.' },
        transport: { type: 'string', enum: ['http', 'sse', 'stdio'], description: 'Transport type.' },
        url: { type: 'string', description: 'Endpoint URL (http/sse transports).' },
        command: { type: 'string', description: 'Executable to spawn (stdio transport).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments (stdio transport).' },
        headers: {
          type: 'array',
          description: 'HTTP headers (http/sse), as { name, value } pairs.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
        env: {
          type: 'array',
          description: 'Environment variables (stdio), as { name, value } pairs.',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'mcp_remove',
    description: 'Remove a global MCP server by name.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Name of the server to remove.' } },
      required: ['name'],
    },
  },
  {
    name: 'mcp_test',
    description:
      'Test connectivity to an MCP server without saving. Pass a full config (same fields as mcp_set) to test an unsaved one, or just `name` to test an already-saved server. Returns ok + tool count, or an error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Server name; used to look up a saved config when other fields are omitted.',
        },
        transport: { type: 'string', enum: ['http', 'sse', 'stdio'] },
        url: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        headers: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
        env: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, value: { type: 'string' } },
            required: ['name', 'value'],
          },
        },
      },
      required: ['name'],
    },
  },

  // ── Skills ───────────────────────────────────────────────────────────────
  ...skillToolDefinitions,

  // ── AskUser ────────────────────────────────────────────────────────────
  {
    name: 'ask_user',
    description:
      'Ask the user structured questions with predefined options. Returns answers in "title"="answer" format. Up to 5 questions, each with up to 5 options plus a custom text input.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        questions: {
          type: 'array',
          description: 'Up to 5 questions to ask the user.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title (1-2 words)' },
              question: { type: 'string', description: 'The question to ask' },
              options: {
                type: 'array',
                description: 'Up to 5 answer options',
                items: { type: 'string' },
                maxItems: 5,
              },
              multiple: { type: 'boolean', description: 'Allow multiple selection' },
            },
            required: ['title', 'question', 'options'],
          },
          maxItems: 5,
        },
        ...SPACE_PARAM,
      },
      required: ['questions'],
    },
  },
]

// ── Agent Tool: dynamic graph-defined tools ───────────────────────────

interface AgentToolNodeData {
  name: string
  description: string
  inputSchema: string
  requireApproval: boolean
}

export async function getAgentToolDefinitions(extraReservedNames: Set<string> = new Set()) {
  const defs: { name: string; description: string; inputSchema: Record<string, unknown> }[] = []

  // Collect all existing static tool names (plus any caller-supplied reserved
  // names, e.g. extension-contributed tools) to avoid collisions
  const staticNames = new Set([...toolDefinitions.map((t) => t.name), ...extraReservedNames])

  try {
    const registry = getSpacesRegistry()
    await registry.ensureLoaded()

    for (const space of registry.list()) {
      const runtime = registry.getBySlug(space.slug)
      if (!runtime) {
        continue
      }

      const nodes = runtime.graph.nodes as unknown as GraphNode[]
      for (const node of nodes) {
        if (node.type !== 'agent-tool') {
          continue
        }

        const d = (node.data ?? {}) as unknown as AgentToolNodeData
        const toolName = d.name?.trim()
        if (!toolName) {
          continue
        }

        if (staticNames.has(toolName)) {
          continue
        } // static tools win
        if (defs.some((x) => x.name === toolName)) {
          continue
        } // first space wins

        let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
        try {
          inputSchema = JSON.parse(d.inputSchema || '{}')
        } catch {
          // skip invalid JSON schema
        }

        defs.push({
          name: toolName,
          description: d.description || `Agent tool: ${toolName}`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              ...((inputSchema.properties as Record<string, unknown>) ?? {}),
            },
          },
        })
      }
    }
  } catch {
    // If spaces can't load, just return empty
  }

  return defs
}

/**
 * Execute an agent-tool node's connected handler script.
 * Returns the handler result or throws on error.
 */
interface AgentToolExecResult {
  result: Record<string, unknown>
  requiredApproval: boolean
}

export interface ToolCallOptions {
  signal?: AbortSignal
  /** Call made by the internal agent: skip the MCP approval queue (the agent chat has its own permission flow). */
  internal?: boolean
}

export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: ToolCallOptions = {},
): Promise<AgentToolExecResult> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()

  // Find the agent-tool node across all spaces
  for (const space of registry.list()) {
    const runtime = registry.getBySlug(space.slug)
    if (!runtime) {
      continue
    }

    const nodes = runtime.graph.nodes as unknown as GraphNode[]

    const toolNode = nodes.find(
      (n) => n.type === 'agent-tool' && ((n.data ?? {}) as Record<string, unknown>).name === toolName,
    )
    if (!toolNode) {
      continue
    }

    // Check requireApproval
    const d = (toolNode.data ?? {}) as unknown as AgentToolNodeData
    const requiredApproval = d.requireApproval && !isYoloMode() && !opts.internal
    if (requiredApproval) {
      await awaitApproval({ tool: toolName, args, view: 'default', signal: opts.signal, spaceId: space.slug })
    }

    // Build event for the handler, then dispatch through the shared
    // execution-context dispatcher (handles both extension `handle` actions
    // and built-in script-node handlers — see exec-dispatch.ts).
    const event = { params: args, context: { toolName: toolName } }

    try {
      const { primary } = await dispatchExecutionContext({
        sourceNodeId: toolNode.id,
        sourceHandleId: 'exec-out',
        event,
      })

      if (primary.error) {
        return { result: textResult(`Agent tool "${toolName}" error: ${primary.error}`), requiredApproval }
      }
      if (typeof primary.body === 'object' && primary.body !== null) {
        return { result: textResult(JSON.stringify(primary.body)), requiredApproval }
      }
      return { result: textResult(String(primary.body ?? '')), requiredApproval }
    } catch (err) {
      if (err instanceof NoExecTargetError) {
        return {
          result: textResult(`Agent tool "${toolName}" has no connected handler script.`),
          requiredApproval: false,
        }
      }
      return {
        result: textResult(`Agent tool "${toolName}" error: ${err instanceof Error ? err.message : String(err)}`),
        requiredApproval,
      }
    }
  }

  throw { code: -32601, message: `Agent tool not found: ${toolName}` }
}

// ── Tool handler registry ──────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>

interface GraphNode {
  id: string
  type?: string
  position?: { x: number; y: number }
  data?: Record<string, unknown>
}

interface StoredEdge extends Record<string, unknown> {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

interface ParsedEndpoint {
  nodeId: string
  handle?: string
}

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text' as const, text }] }
}

function fail(code: number, message: string): never {
  throw { code, message }
}

// ── MCP server helpers ─────────────────────────────────────────────────────

const MCP_TRANSPORTS: McpTransport[] = ['http', 'sse', 'stdio']
const SECRET_MASK = '***'

function parseKeyValues(raw: unknown): KeyValue[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw)) {
    fail(-32602, 'headers/env must be an array of { name, value }')
  }
  return raw.map((item) => {
    const obj = (item ?? {}) as Record<string, unknown>
    const name = typeof obj.name === 'string' ? obj.name : ''
    if (!name) {
      fail(-32602, 'each headers/env entry needs a name')
    }
    return { name, value: typeof obj.value === 'string' ? obj.value : '' }
  })
}

// Build an McpServerConfig from tool args, merging onto an existing entry so
// omitted fields are preserved — lets an agent patch one field without wiping
// secret headers/env it can't see (those are redacted on read).
function mcpConfigFromArgs(args: Record<string, unknown>, existing?: McpServerConfig): McpServerConfig {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) {
    fail(-32602, 'Missing required param: name')
  }
  const transport = (typeof args.transport === 'string' ? args.transport : undefined) ?? existing?.transport ?? 'http'
  if (!MCP_TRANSPORTS.includes(transport as McpTransport)) {
    fail(-32602, `transport must be one of: ${MCP_TRANSPORTS.join(', ')}`)
  }
  const config: McpServerConfig = {
    name,
    transport: transport as McpTransport,
    url: typeof args.url === 'string' ? args.url : existing?.url,
    command: typeof args.command === 'string' ? args.command : existing?.command,
    args: Array.isArray(args.args) ? (args.args as unknown[]).map(String) : existing?.args,
    headers: parseKeyValues(args.headers) ?? existing?.headers,
    env: parseKeyValues(args.env) ?? existing?.env,
  }
  if (config.transport === 'stdio') {
    if (!config.command) {
      fail(-32602, 'stdio transport requires a command')
    }
  } else if (!config.url) {
    fail(-32602, `${config.transport} transport requires a url`)
  }
  return config
}

function redactUrl(url?: string): string | undefined {
  if (!url) {
    return url
  }
  try {
    const u = new URL(url)
    if (u.username || u.password) {
      u.username = u.username ? SECRET_MASK : ''
      u.password = u.password ? SECRET_MASK : ''
    }
    return u.toString()
  } catch {
    return url
  }
}

// Never echo secret values (header/env values, URL credentials) back to agents.
function redactMcpServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    url: redactUrl(server.url),
    headers: server.headers?.map((h) => ({ name: h.name, value: SECRET_MASK })),
    env: server.env?.map((e) => ({ name: e.name, value: SECRET_MASK })),
  }
}

async function resolveSpace(args: Record<string, unknown>): Promise<string> {
  const input = args.space as string | undefined
  if (!input) {
    return getActiveSpaceSlugImpl()
  }
  const spaces = await listSpacesImpl()
  const bySlug = spaces.find((s) => s.slug === input)
  if (bySlug) {
    return bySlug.slug
  }
  fail(-32602, `Space not found: ${input} (use a slug — see list_spaces)`)
}

async function loadOrFail(slug: string): Promise<{ graph: GraphData; updatedAt: string }> {
  const result = await loadSpaceGraphImpl(slug)
  if (!result) {
    fail(-32602, `Space not found: ${slug}`)
  }
  return result
}

function broadcastExtensionsUpdated(): void {
  toastStore.broadcast({ type: 'extensions_updated' })
}

function edgeMatches(edge: StoredEdge, endpoint: { source: ParsedEndpoint; target: ParsedEndpoint }): boolean {
  if (edge.source !== endpoint.source.nodeId || edge.target !== endpoint.target.nodeId) {
    return false
  }
  if (endpoint.source.handle !== undefined && edge.sourceHandle !== endpoint.source.handle) {
    return false
  }
  if (endpoint.target.handle !== undefined && edge.targetHandle !== endpoint.target.handle) {
    return false
  }
  return true
}

function parseEndpoint(raw: string): ParsedEndpoint {
  const i = raw.indexOf('/')
  if (i === -1) {
    return { nodeId: raw }
  }
  return { nodeId: raw.slice(0, i), handle: raw.slice(i + 1) }
}

function formatEndpoint(nodeId: string, handle?: string): string {
  return handle ? `${nodeId}/${handle}` : nodeId
}

function edgeToApi(edge: StoredEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: formatEndpoint(edge.source, edge.sourceHandle),
    target: formatEndpoint(edge.target, edge.targetHandle),
  }
}

async function buildTypeNameMap(): Promise<Map<string, string>> {
  const manifests = await loadAllManifests()
  const map = new Map<string, string>()
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.typeId, node.name)
    }
  }
  return map
}

interface TypeHandlesContext {
  typeHandles: Map<string, ExtensionHandle[]>
  // Resolved once here rather than per node inside the expansion.
  dockerExtensionId: string | null
}

async function buildTypeHandlesMap(): Promise<TypeHandlesContext> {
  const manifests = await loadAllManifests()
  const byType = buildNodeTypeHandles(manifests)
  return {
    typeHandles: new Map(Array.from(byType, ([typeId, entry]) => [typeId, entry.handles])),
    dockerExtensionId: findDockerExtensionId(manifests),
  }
}

interface NodeHandlesView {
  input: Record<string, string | null>
  output: Record<string, string[]>
}

async function nodeHandles(
  node: GraphNode,
  edges: StoredEdge[],
  { typeHandles, dockerExtensionId }: TypeHandlesContext,
): Promise<NodeHandlesView> {
  const input: Record<string, string | null> = {}
  const output: Record<string, string[]> = {}
  const declared = node.type ? (typeHandles.get(node.type) ?? []) : []
  for (const h of declared) {
    if (h.role === 'target') {
      input[h.id] = null
      continue
    }
    if (h.dynamic) {
      continue
    }
    output[h.id] = []
  }
  for (const id of await expandDynamicHandles(node, declared, dockerExtensionId)) {
    output[id] = []
  }
  for (const edge of edges) {
    if (edge.target === node.id && edge.targetHandle) {
      input[edge.targetHandle] = formatEndpoint(edge.source, edge.sourceHandle)
      continue
    }
    if (edge.source === node.id && edge.sourceHandle) {
      const list = output[edge.sourceHandle] ?? []
      list.push(formatEndpoint(edge.target, edge.targetHandle))
      output[edge.sourceHandle] = list
    }
  }
  return { input, output }
}

function nodeName(node: GraphNode, typeNames: Map<string, string>): string {
  const name = node.type ? typeNames.get(node.type) : undefined
  return name ?? node.type ?? node.id
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${body}$`, 'i')
}

function globLiteral(pattern: string): string {
  const parts = pattern.split(/[*?]+/).filter(Boolean)
  return parts.reduce((best, p) => (p.length > best.length ? p : best), '')
}

function snippet(value: string, pattern: string, radius = 100): string {
  const literal = globLiteral(pattern)
  if (!literal) {
    return value.length <= radius * 2 ? value : `${value.slice(0, radius * 2)}…`
  }
  const idx = value.toLowerCase().indexOf(literal.toLowerCase())
  if (idx === -1) {
    return value.length <= radius * 2 ? value : `${value.slice(0, radius * 2)}…`
  }
  const start = Math.max(0, idx - radius)
  const end = Math.min(value.length, idx + literal.length + radius)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < value.length ? '…' : ''
  return prefix + value.slice(start, end) + suffix
}

function walkLeaves(value: unknown, path: string, out: Map<string, string>): void {
  if (value === null || value === undefined) {
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walkLeaves(item, `${path}[${i}]`, out)
    })
    return
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${k}` : k
      walkLeaves(v, next, out)
    }
    return
  }
  out.set(path, String(value))
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cur[key]
    if (next === null || typeof next !== 'object') {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function requireArray<T = unknown>(value: unknown, name: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(-32602, `Missing required param: ${name} (non-empty array)`)
  }
  return value as T[]
}

// ── Remote ops helpers ────────────────────────────────────────────────────

const CORE_EXTENSION_ID = 'builtin/core'

async function findNodeAcrossSpaces(nodeId: string): Promise<{ node: GraphNode; slug: string }> {
  const spaces = await listSpacesImpl()
  for (const space of spaces) {
    const result = await loadSpaceGraphImpl(space.slug)
    const node = result?.graph.nodes.find((n) => (n as { id?: string }).id === nodeId) as GraphNode | undefined
    if (node) {
      return { node, slug: space.slug }
    }
  }
  fail(-32602, `Node not found: ${nodeId}`)
}

// The node-id sentinel used by the static per-extension terminal-context handle
// ("extensions/<slug>"), resolved by `resolveLocalExtensionContext` below instead of a real
// graph node lookup.
const LOCAL_EXTENSION_HANDLE_NODE_ID = 'extensions'

// Conservative allow-list for a local extension folder name: must start alphanumeric, then only
// alphanumeric/dot/underscore/hyphen. This can never contain "/", "\", or "..", but both are also
// rejected explicitly in `isValidLocalExtensionSlug` for defense in depth.
const LOCAL_EXTENSION_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * True for slugs that are safe to join onto `localExtRoot()` with no path-traversal risk. Pure
 * and side-effect free, so it's unit-testable on its own.
 */
export function isValidLocalExtensionSlug(slug: string): boolean {
  if (!slug || slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    return false
  }
  return LOCAL_EXTENSION_SLUG_RE.test(slug)
}

/**
 * Resolve a non-absolute `filePath` against `cwd` (when the resolved terminal context has one).
 * Absolute paths, and any path when there's no cwd, pass through unchanged. Pure and side-effect
 * free (no network/filesystem calls), so it's unit-testable on its own — this is what lets
 * `remote_read target=extensions/git path=server/git.ts` resolve to
 * `<localExtRoot>/git/server/git.ts` before it ever reaches a shell command.
 */
export function resolveRemoteFilePath(filePath: string, cwd?: string): string {
  if (!cwd || path.isAbsolute(filePath)) {
    return filePath
  }
  return path.posix.join(cwd, filePath)
}

/**
 * Build the `local` terminal context for an already-syntax-validated extension `slug`, given the
 * set of currently-installed local extension slugs and the local extensions root. Pure and
 * side-effect free (no I/O, no listLocalExtensions() call, no MCP/server runtime needed), so
 * it's unit-testable on its own — this is the part of extension-handle resolution that isn't
 * just string validation.
 */
export function buildLocalExtensionCtx(
  slug: string,
  knownSlugs: string[],
  extensionsRoot: string,
): Record<string, unknown> {
  if (!knownSlugs.includes(slug)) {
    fail(-32602, `Unknown local extension: ${slug}`)
  }
  return { type: 'local', cwd: path.join(extensionsRoot, slug) }
}

/**
 * Resolve the static "extensions/<slug>" handle to a `local` terminal context rooted at that
 * local extension's folder on disk (`data/extensions/local/<slug>/`). Returns undefined when
 * `ep.nodeId` isn't the "extensions" sentinel, so the caller falls back to normal node-graph
 * resolution. The slug is validated both syntactically (no traversal — before any I/O happens)
 * and against the actual set of installed local extensions (the same loader
 * `list_extensions`/`get_extension` use) before ever being joined onto a filesystem path.
 */
async function resolveLocalExtensionContext(ep: ParsedEndpoint): Promise<Record<string, unknown> | undefined> {
  if (ep.nodeId !== LOCAL_EXTENSION_HANDLE_NODE_ID) {
    return undefined
  }
  const slug = ep.handle
  if (!slug || !isValidLocalExtensionSlug(slug)) {
    fail(-32602, `Invalid local extension handle: "${ep.handle ?? ''}"`)
  }
  const records = await listLocalExtensionsImpl()
  return buildLocalExtensionCtx(
    slug,
    records.map((r) => r.slug),
    localExtRoot(),
  )
}

export async function resolveTerminalContext(
  args: Record<string, unknown>,
): Promise<{ ctx: Record<string, unknown>; slug: string }> {
  const target = args.target as string | undefined
  if (!target) {
    fail(-32602, 'Missing required param: target')
  }
  const ep = parseEndpoint(target)
  if (!ep.handle) {
    fail(-32602, 'target must include handle (format: "node-id/handle-id")')
  }

  const localExtCtx = await resolveLocalExtensionContext(ep)
  if (localExtCtx) {
    return { ctx: localExtCtx, slug: ep.handle }
  }

  const { node, slug } = await findNodeAcrossSpaces(ep.nodeId)
  if (!node.type) {
    fail(-32602, `Node ${ep.nodeId} has no type`)
  }

  const manifests = await loadAllManifests()
  const manifest = manifests.find((m) => m.nodes?.some((n) => n.typeId === node.type))
  if (!manifest) {
    fail(-32602, `No extension provides node type: ${node.type}`)
  }

  const mod = await getExtensionModule(manifest.id)
  if (!mod.exposeOutput) {
    fail(-32602, `Extension ${manifest.id} has no exposeOutput`)
  }

  const ctx = mod.exposeOutput(ep.handle, node.data ?? {}, node.type)
  if (ctx === undefined || ctx === null) {
    fail(-32602, `No context value for ${target}`)
  }

  return { ctx: ctx as Record<string, unknown>, slug }
}

export async function remoteExec(
  ctx: Record<string, unknown>,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const core = await getExtensionModule(CORE_EXTENSION_ID)
  const execFn = core.actions['terminal.exec']
  if (!execFn) {
    fail(-32603, 'Core extension has no terminal.exec action')
  }
  return execFn(ctx, command, opts) as Promise<string>
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Exact-string replacement shared by remote_edit and edit_node_property: enforces the
 * found/unique contract, and uses a function replacer so dollar-prefixed substitution patterns
 * in newString are inserted literally instead of being expanded.
 */
export function replaceExact(
  content: string,
  edit: { oldString: string; newString: string; replaceAll: boolean },
  subject: string,
): string {
  const occurrences = content.split(edit.oldString).length - 1
  if (occurrences === 0) {
    fail(-32602, `oldString not found in ${subject}`)
  }
  if (occurrences > 1 && !edit.replaceAll) {
    fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`)
  }
  if (edit.replaceAll) {
    return content.split(edit.oldString).join(edit.newString)
  }
  return content.replace(edit.oldString, () => edit.newString)
}

/**
 * Translate a glob pattern (** spans "/", * doesn't, ? = one char) into an anchored POSIX
 * extended regex suitable for grep -E. remote_glob enumerates files with plain find and filters
 * with grep instead of doing unquoted shell glob expansion, which would need pattern left
 * unescaped in the command string and would be an injection risk since it comes from the caller.
 */
export function globPatternToEre(pattern: string): string {
  const special = '.+^$(){}|[]\\'
  let ere = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        ere += '.*'
        i++
      } else {
        ere += '[^/]*'
      }
    } else if (c === '?') {
      ere += '[^/]'
    } else if (special.includes(c)) {
      ere += `\\${c}`
    } else {
      ere += c
    }
  }
  return `^${ere}$`
}

// Byte cap piped through `head -c` on the remote so a match-heavy search transfers a bounded
// amount, and per-line column cap applied client-side so one minified bundle line can't eat the
// whole result budget on its own.
const SEARCH_BYTE_CAP = 256 * 1024
const SEARCH_MAX_COLUMNS = 500
const SEARCH_LIMIT_DEFAULT = 200

/** True when `p` has a path segment remote search skips by default — the caller explicitly
 * targeting e.g. node_modules is the signal to search it after all. */
export function insideExcludedDir(p: string): boolean {
  return p.split('/').some((segment) => SEARCH_EXCLUDED_DIRS.includes(segment))
}

function searchSkipsExcludedDirs(args: Record<string, unknown>, resolvedPath: string): boolean {
  if (args.includeIgnored === true) {
    return false
  }
  return !insideExcludedDir(resolvedPath)
}

/** Column-truncate one result line, noting how much was cut. */
export function capColumns(line: string): string {
  if (line.length <= SEARCH_MAX_COLUMNS) {
    return line
  }
  return `${line.slice(0, SEARCH_MAX_COLUMNS)} … [+${line.length - SEARCH_MAX_COLUMNS} chars]`
}

function searchLimit(args: Record<string, unknown>): number {
  if (typeof args.limit === 'number' && args.limit > 0) {
    return Math.floor(args.limit)
  }
  return SEARCH_LIMIT_DEFAULT
}

/** Shared tail of remote_glob/remote_grep: strip "./" prefixes, apply the line limit and column
 * cap, and append a truncation note instead of silently dropping the rest. */
function renderSearchResult(output: string, limit: number): Record<string, unknown> {
  const capped = Buffer.byteLength(output, 'utf8') >= SEARCH_BYTE_CAP
  let lines = output.split('\n').filter(Boolean)
  if (capped) {
    lines = lines.slice(0, -1)
  }
  if (lines.length === 0) {
    return textResult('(no matches)')
  }
  const truncated = capped || lines.length > limit
  const body = lines
    .slice(0, limit)
    .map((line) => capColumns(line.replace(/^\.\//, '')))
    .join('\n')
  if (!truncated) {
    return textResult(body)
  }
  return textResult(`${body}\n… (truncated — narrow the pattern, path, or glob to see the rest)`)
}

// Base64 chunk size (of encoded text, per command) for remote writes — keeps each `remoteExec`
// invocation well under typical ARG_MAX limits while still writing large files in few round trips.
const BASE64_WRITE_CHUNK_SIZE = 48 * 1024

/**
 * Build the shell commands that reconstruct `content` byte-for-byte on the remote as `filePath`:
 * `printf '%s' <base64-chunk> | base64 -d >[>]  <file>`, first chunk truncating, the rest
 * appending. Pure and side-effect free (no network calls) so it's unit-testable on its own —
 * unlike the old `cat > file << 'OPENCROFTEOF' ... OPENCROFTEOF` heredoc, this can't be corrupted
 * by a file that happens to contain the marker line, and never strips/adds a trailing newline.
 */
export function buildBase64WriteCommands(
  filePath: string,
  content: string,
  chunkSize: number = BASE64_WRITE_CHUNK_SIZE,
): string[] {
  const quotedPath = shellQuote(filePath)
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  if (b64.length === 0) {
    return [`: > ${quotedPath}`]
  }
  const commands: string[] = []
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize)
    const redirect = i === 0 ? '>' : '>>'
    commands.push(`printf '%s' ${shellQuote(chunk)} | base64 -d ${redirect} ${quotedPath}`)
  }
  return commands
}

/**
 * Write `content` to `filePath` on the remote exactly byte-for-byte via base64 chunks, then
 * verify the write with `wc -c` and fail loudly on any mismatch.
 */
async function writeRemoteFileExact(
  ctx: Record<string, unknown>,
  filePath: string,
  content: string,
  opts?: { cwd?: string },
): Promise<void> {
  for (const command of buildBase64WriteCommands(filePath, content)) {
    await remoteExec(ctx, command, opts)
  }
  const expectedBytes = Buffer.byteLength(content, 'utf8')
  const wcOut = await remoteExec(ctx, `wc -c < ${shellQuote(filePath)}`, opts)
  const actualBytes = Number.parseInt(wcOut.trim(), 10)
  if (!Number.isFinite(actualBytes) || actualBytes !== expectedBytes) {
    const reported = Number.isFinite(actualBytes) ? String(actualBytes) : wcOut.trim() || '(empty)'
    fail(
      -32603,
      `Write verification failed for ${filePath}: expected ${expectedBytes} bytes, remote reports ${reported}.`,
    )
  }
}

// Resolves each name to a plain env map and lets the terminal backend (packages/terminal) inject
// it out of band -- never build the command string ourselves. A value spliced into a shell
// string, however it's encoded, ends up in that process's argv for its whole lifetime, readable
// by `ps`/`pgrep` to anyone else on the same host; a value handed to the backend as `env` never
// touches argv at all (see buildEnvInjection in packages/terminal/src/server/exec-util.ts).
async function resolveSecretsEnv(names: string[] | undefined): Promise<Record<string, string> | undefined> {
  if (!names || names.length === 0) {
    return undefined
  }
  const env: Record<string, string> = {}
  for (const name of names) {
    const value = await secrets.resolve(name)
    if (value === null) {
      fail(-32602, `Secret "${name}" not found in any Secrets Store`)
    }
    env[name] = value
  }
  return env
}

function catN(content: string, startLine = 1): string {
  const lines = content.split('\n')
  const lastLineNo = startLine + lines.length - 1
  const width = String(lastLineNo).length
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`).join('\n')
}

function sliceLines(content: string, offset?: number, limit?: number): string {
  if (offset == null && limit == null) {
    return content
  }
  const lines = content.split('\n')
  const start = Math.max(0, (offset ?? 1) - 1)
  const end = limit != null ? Math.min(lines.length, start + limit) : lines.length
  return lines.slice(start, end).join('\n')
}

function buildHandlers(): Record<string, ToolHandler> {
  return {
    // ── send_toast ──────────────────────────────────────────────────
    send_toast: async (args) => {
      const message = args.message as string | undefined
      if (!message) {
        fail(-32602, 'Missing required param: message')
      }
      const type = (args.type as string) || 'info'
      const spaceId = args.space as string | undefined
      toastStore.broadcast({
        type: 'toast',
        message,
        toastType: type as 'info' | 'success' | 'warning' | 'error',
        ...(spaceId ? { spaceId } : {}),
      })
      return textResult(`Toast sent: [${type}] ${message}`)
    },

    // ── list_spaces ─────────────────────────────────────────────────
    list_spaces: async () => {
      const spaces = await listSpacesImpl()
      return textResult(JSON.stringify(spaces, null, 2))
    },

    // ── create_space ────────────────────────────────────────────────
    create_space: withApprovalRequired(async (args) => {
      const name = args.name as string | undefined
      if (!name) {
        fail(-32602, 'Missing required param: name')
      }
      const space = await createSpaceImpl(name)
      return textResult(JSON.stringify(space, null, 2))
    }),

    // ── rename_space ────────────────────────────────────────────────
    rename_space: withApprovalRequired(async (args) => {
      const name = args.name as string | undefined
      if (!args.space || !name) {
        fail(-32602, 'Missing required params: space, name')
      }
      const slug = await resolveSpace(args)
      const space = await renameSpaceImpl({ slug, name })
      if (!space) {
        fail(-32602, `Space not found: ${slug}`)
      }
      return textResult(JSON.stringify(space, null, 2))
    }),

    // ── delete_space ────────────────────────────────────────────────
    delete_space: withApprovalRequired(async (args) => {
      if (!args.space) {
        fail(-32602, 'Missing required param: space')
      }
      const slug = await resolveSpace(args)
      const ok = await deleteSpaceImpl(slug)
      if (!ok) {
        fail(-32602, 'Cannot delete (not found or last remaining space)')
      }
      return textResult(`Space ${slug} deleted.`)
    }),

    // ── list_nodes ──────────────────────────────────────────────────
    list_nodes: async (args) => {
      const slug = await resolveSpace(args)
      const { graph } = await loadOrFail(slug)
      const typeNames = await buildTypeNameMap()
      const entries = graph.nodes.map((n) => {
        const node = n as unknown as GraphNode
        return { id: node.id, name: nodeName(node, typeNames) }
      })
      return textResult(JSON.stringify(entries, null, 2))
    },

    // ── find_nodes ──────────────────────────────────────────────────
    find_nodes: async (args) => {
      const patterns = requireArray<string>(args.patterns, 'patterns')
      const slug = await resolveSpace(args)
      const { graph } = await loadOrFail(slug)
      const typeNames = await buildTypeNameMap()
      const regexes = patterns.map((p) => ({ pattern: p, regex: globToRegex(p) }))
      const results: Record<string, unknown>[] = []
      for (const n of graph.nodes) {
        const node = n as unknown as GraphNode
        const name = nodeName(node, typeNames)
        const hasName = name !== node.id && name !== node.type
        const fields = new Map<string, string>()
        if (hasName) {
          fields.set('name', name)
        }
        if (node.type) {
          fields.set('type', node.type)
        }
        if (node.data) {
          walkLeaves(node.data, 'data', fields)
        }
        const matches: Record<string, string> = {}
        for (const [path, value] of fields) {
          for (const { pattern, regex } of regexes) {
            if (regex.test(value)) {
              matches[path] = snippet(value, pattern)
              break
            }
          }
        }
        if (Object.keys(matches).length === 0) {
          continue
        }
        const entry: Record<string, unknown> = { id: node.id }
        if (hasName) {
          entry.name = name
        }
        if (node.type) {
          entry.type = node.type
        }
        if (node.position) {
          entry.position = node.position
        }
        entry.matches = matches
        results.push(entry)
      }
      return textResult(JSON.stringify(results, null, 2))
    },

    // ── get_nodes ───────────────────────────────────────────────────
    get_nodes: async (args) => {
      const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds')
      const slug = await resolveSpace(args)
      const { graph } = await loadOrFail(slug)
      const typeHandles = await buildTypeHandlesMap()
      const edges = graph.edges as StoredEdge[]
      const index = new Map<string, GraphNode>()
      for (const n of graph.nodes) {
        index.set((n as unknown as GraphNode).id, n as unknown as GraphNode)
      }
      const found: unknown[] = []
      const missing: string[] = []
      for (const id of nodeIds) {
        const node = index.get(id)
        if (node) {
          found.push({ ...node, handles: await nodeHandles(node, edges, typeHandles) })
          continue
        }
        missing.push(id)
      }
      return textResult(JSON.stringify({ found, missing }, null, 2))
    },

    // ── create_nodes ────────────────────────────────────────────────
    create_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.nodes, 'nodes')
      for (const it of items) {
        if (!it.type || typeof it.type !== 'string') {
          fail(-32602, 'Each node must include a string "type"')
        }
      }
      const slug = await resolveSpace(args)
      const created = await withGraphConflictRetry(slug, (graph) => {
        let maxY = graph.nodes.reduce((max, n) => {
          const py = (n as { position?: { y?: number } }).position?.y ?? 0
          return Math.max(max, py)
        }, 0)
        const createdNodes: GraphNode[] = []
        for (const it of items) {
          const userPos = it.position as { x: number; y: number } | undefined
          if (userPos) {
            maxY = Math.max(maxY, userPos.y)
          } else {
            maxY += 150
          }
          const position = userPos ?? { x: 100, y: maxY }
          const data = (it.data as Record<string, unknown>) ?? {}
          const node: GraphNode = {
            id: crypto.randomUUID(),
            type: it.type as string,
            position,
            data,
          }
          graph.nodes.push(node as unknown as Record<string, unknown>)
          createdNodes.push(node)
        }
        return createdNodes
      })
      return textResult(JSON.stringify(created, null, 2))
    }),

    // ── update_nodes ────────────────────────────────────────────────
    update_nodes: withApprovalRequired(
      async (args) => {
        const items = requireArray<Record<string, unknown>>(args.updates, 'updates')
        const slug = await resolveSpace(args)
        const updated = await withGraphConflictRetry(slug, (graph) => {
          const index = new Map<string, GraphNode>()
          for (const n of graph.nodes) {
            const node = n as unknown as GraphNode
            index.set(node.id, node)
          }
          const missing: string[] = []
          for (const it of items) {
            const nodeId = it.nodeId as string | undefined
            if (!nodeId) {
              fail(-32602, 'Each update must include "nodeId"')
            }
            if (!index.has(nodeId)) {
              missing.push(nodeId)
            }
          }
          if (missing.length > 0) {
            fail(-32602, `Nodes not found: ${missing.join(', ')}`)
          }
          const updatedNodes: GraphNode[] = []
          for (const it of items) {
            const node = index.get(it.nodeId as string)
            if (!node) {
              continue
            }
            const data = it.data as Record<string, unknown> | undefined
            if (data) {
              node.data = { ...(node.data ?? {}), ...data }
            }
            const position = it.position as { x: number; y: number } | undefined
            if (position) {
              node.position = position
            }
            updatedNodes.push(node)
          }
          return updatedNodes
        })
        return textResult(JSON.stringify(updated, null, 2))
      },
      { view: 'update_nodes' },
    ),

    // ── write_node_property ─────────────────────────────────────────
    write_node_property: withApprovalRequired(
      async (args) => {
        const nodeId = args.nodeId as string | undefined
        const propPath = args.path as string | undefined
        const value = args.value as string | undefined
        if (!nodeId || !propPath || value === undefined) {
          fail(-32602, 'Missing required params: nodeId, path, value')
        }
        const slug = await resolveSpace(args)
        await withGraphConflictRetry(slug, (graph) => {
          const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined
          if (!node) {
            fail(-32602, `Node not found: ${nodeId}`)
          }
          if (!node.data) {
            node.data = {}
          }
          setByPath(node.data, propPath, value)
        })
        return textResult(`Property ${propPath} on ${nodeId} written.`)
      },
      { view: 'write_node_property' },
    ),

    // ── edit_node_property ──────────────────────────────────────────
    edit_node_property: withApprovalRequired(
      async (args) => {
        const nodeId = args.nodeId as string | undefined
        const propPath = args.path as string | undefined
        const oldString = args.oldString as string | undefined
        const newString = args.newString as string | undefined
        if (!nodeId || !propPath || oldString === undefined || newString === undefined) {
          fail(-32602, 'Missing required params: nodeId, path, oldString, newString')
        }
        if (oldString === newString) {
          fail(-32602, 'oldString and newString must differ')
        }
        const replaceAll = Boolean(args.replaceAll)
        const slug = await resolveSpace(args)
        await withGraphConflictRetry(slug, (graph) => {
          const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined
          if (!node) {
            fail(-32602, `Node not found: ${nodeId}`)
          }
          const current = getByPath(node.data ?? {}, propPath)
          if (typeof current !== 'string') {
            fail(-32602, `Property ${propPath} is not a string`)
          }
          const updated = replaceExact(current, { oldString, newString, replaceAll }, 'property')
          if (!node.data) {
            node.data = {}
          }
          setByPath(node.data, propPath, updated)
        })
        return textResult(`Property ${propPath} on ${nodeId} updated.`)
      },
      { view: 'edit_node_property' },
    ),

    // ── delete_nodes ────────────────────────────────────────────────
    delete_nodes: withApprovalRequired(async (args) => {
      const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds')
      const slug = await resolveSpace(args)
      const removedEdges = await withGraphConflictRetry(slug, (graph) => {
        const existing = new Set(graph.nodes.map((n) => (n as { id: string }).id))
        const missing = nodeIds.filter((id) => !existing.has(id))
        if (missing.length > 0) {
          fail(-32602, `Nodes not found: ${missing.join(', ')}`)
        }
        const targets = new Set(nodeIds)
        graph.nodes = graph.nodes.filter((n) => !targets.has((n as { id: string }).id))
        const beforeEdges = graph.edges.length
        graph.edges = graph.edges.filter((e) => {
          const edge = e as { source: string; target: string }
          return !targets.has(edge.source) && !targets.has(edge.target)
        })
        return beforeEdges - graph.edges.length
      })
      return textResult(JSON.stringify({ deleted: nodeIds, removedEdges }, null, 2))
    }),

    // ── list_edges ──────────────────────────────────────────────────
    list_edges: async (args) => {
      const slug = await resolveSpace(args)
      const { graph } = await loadOrFail(slug)
      const edges = graph.edges.map((e) => edgeToApi(e as StoredEdge))
      return textResult(JSON.stringify(edges, null, 2))
    },

    // ── connect_nodes ───────────────────────────────────────────────
    connect_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.edges, 'edges')
      const slug = await resolveSpace(args)
      const created = await withGraphConflictRetry(slug, (graph) => {
        const nodeIds = new Set(graph.nodes.map((n) => (n as { id: string }).id))
        const parsed = items.map((it) => {
          if (!it.source || !it.target || typeof it.source !== 'string' || typeof it.target !== 'string') {
            fail(-32602, 'Each edge must include "source" and "target"')
          }
          const source = parseEndpoint(it.source as string)
          const target = parseEndpoint(it.target as string)
          if (!nodeIds.has(source.nodeId)) {
            fail(-32602, `Source node not found: ${source.nodeId}`)
          }
          if (!nodeIds.has(target.nodeId)) {
            fail(-32602, `Target node not found: ${target.nodeId}`)
          }
          const exists = (graph.edges as StoredEdge[]).some((e) => edgeMatches(e, { source, target }))
          if (exists) {
            fail(-32602, `Edge already exists: ${it.source} -> ${it.target}`)
          }
          return { source, target }
        })
        const createdEdges: Record<string, unknown>[] = []
        for (const p of parsed) {
          const edge: StoredEdge = {
            id: crypto.randomUUID(),
            source: p.source.nodeId,
            target: p.target.nodeId,
          }
          if (p.source.handle) {
            edge.sourceHandle = p.source.handle
          }
          if (p.target.handle) {
            edge.targetHandle = p.target.handle
          }
          graph.edges.push(edge)
          createdEdges.push(edgeToApi(edge))
        }
        return createdEdges
      })
      return textResult(JSON.stringify(created, null, 2))
    }),

    // ── disconnect_nodes ────────────────────────────────────────────
    disconnect_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.edges, 'edges')
      const slug = await resolveSpace(args)
      const removed = await withGraphConflictRetry(slug, (graph) => {
        const indices: number[] = []
        for (const it of items) {
          if (!it.source || !it.target || typeof it.source !== 'string' || typeof it.target !== 'string') {
            fail(-32602, 'Each edge must include "source" and "target"')
          }
          const source = parseEndpoint(it.source as string)
          const target = parseEndpoint(it.target as string)
          const idx = (graph.edges as StoredEdge[]).findIndex(
            (e, i) => !indices.includes(i) && edgeMatches(e, { source, target }),
          )
          if (idx === -1) {
            fail(-32602, `Edge not found: ${it.source} -> ${it.target}`)
          }
          indices.push(idx)
        }
        indices.sort((a, b) => b - a)
        const removedIds: string[] = []
        for (const idx of indices) {
          const edge = graph.edges.splice(idx, 1)[0] as StoredEdge
          removedIds.push(edge.id)
        }
        return removedIds
      })
      return textResult(JSON.stringify({ removed }, null, 2))
    }),

    // ── focus_node ──────────────────────────────────────────────────
    focus_node: async (args) => {
      const nodeId = args.nodeId as string | undefined
      if (!nodeId) {
        fail(-32602, 'Missing required param: nodeId')
      }
      const space = await findSpaceByNodeImpl(nodeId)
      if (!space) {
        fail(-32602, `Node not found in any space: ${nodeId}`)
      }
      toastStore.broadcast({ type: 'open_space', slug: space.slug, nodeId })
      toastStore.broadcast({ type: 'focus_node', nodeId, spaceId: space.slug })
      const comment = args.comment as string | undefined
      if (!comment) {
        return textResult(`Focused on node ${nodeId} in space ${space.slug}`)
      }
      toastStore.broadcast({ type: 'comment', message: comment, nodeId, spaceId: space.slug })
      return textResult(JSON.stringify({ nodeId, comment, space: space.slug }))
    },

    // ── comment_nodes ───────────────────────────────────────────────
    comment_nodes: async (args) => {
      const items = requireArray<Record<string, unknown>>(args.comments, 'comments')
      const entries: { nodeId: string; message: string }[] = []
      for (const it of items) {
        const nodeId = it.nodeId as string | undefined
        const message = it.message as string | undefined
        if (!nodeId || !message) {
          fail(-32602, 'Each comment must include "nodeId" and "message"')
        }
        entries.push({ nodeId, message })
      }
      const slug = await resolveSpace(args)
      for (const entry of entries) {
        toastStore.broadcast({ type: 'comment', message: entry.message, nodeId: entry.nodeId, spaceId: slug })
      }
      return textResult(JSON.stringify(entries, null, 2))
    },

    // ── uncomment_nodes ─────────────────────────────────────────────
    uncomment_nodes: async (args) => {
      const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds')
      const slug = await resolveSpace(args)
      for (const nodeId of nodeIds) {
        toastStore.broadcast({ type: 'clear_comment', nodeId, spaceId: slug })
      }
      return textResult(JSON.stringify({ cleared: nodeIds }, null, 2))
    },

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
    compile_extension: withApprovalRequired(async (args) => {
      const extensionId = args.extensionId as string | undefined
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId')
      }
      try {
        const result = await compileLocalExtensionImpl(extensionId)
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

    // ── read (remote) ────────────────────────────────────────────────
    remote_read: async (args) => {
      const filePath = args.path as string | undefined
      if (!filePath) {
        fail(-32602, 'Missing required param: path')
      }
      const offset = args.offset as number | undefined
      const limit = args.limit as number | undefined
      const { ctx } = await resolveTerminalContext(args)
      const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)
      const content = await remoteExec(ctx, `cat ${shellQuote(resolvedPath)}`)
      const sliced = sliceLines(content, offset, limit)
      return textResult(catN(sliced, offset ?? 1))
    },

    // ── glob (remote) ────────────────────────────────────────────────
    remote_glob: async (args) => {
      const pattern = args.pattern as string | undefined
      if (!pattern) {
        fail(-32602, 'Missing required param: pattern')
      }
      const { ctx } = await resolveTerminalContext(args)
      const dirArg = args.path as string | undefined
      const searchDir = dirArg
        ? resolveRemoteFilePath(dirArg, ctx.cwd as string | undefined)
        : (ctx.cwd as string | undefined)
      const steps = [`sed 's|^\\./||'`, `grep -E -- ${shellQuote(globPatternToEre(pattern))}`]
      const exclude = args.exclude as string | undefined
      if (exclude) {
        steps.push(`grep -Ev -- ${shellQuote(globPatternToEre(exclude))}`)
      }
      let prune = ''
      if (searchSkipsExcludedDirs(args, searchDir ?? '')) {
        const names = SEARCH_EXCLUDED_DIRS.map((dir) => `-name ${shellQuote(dir)}`).join(' -o ')
        prune = `'(' ${names} ')' -prune -o `
      }
      const command = `find . ${prune}-type f -print | ${steps.join(' | ')} | head -c ${SEARCH_BYTE_CAP}; true`
      const output = await remoteExec(ctx, command, searchDir ? { cwd: searchDir } : undefined)
      return renderSearchResult(output, searchLimit(args))
    },

    // ── grep (remote) ────────────────────────────────────────────────
    remote_grep: async (args) => {
      const pattern = args.pattern as string | undefined
      if (!pattern) {
        fail(-32602, 'Missing required param: pattern')
      }
      const { ctx } = await resolveTerminalContext(args)
      const cwd = ctx.cwd as string | undefined
      // Run grep from the target's cwd and pass `path` in the caller's own form, so result lines
      // echo that form back (relative by default) instead of repeating an absolute prefix.
      const searchPath = (args.path as string | undefined) ?? '.'
      // -H keeps the "path:line:text" shape even when `path` is a single file.
      const parts = ['grep', '-r', '-n', '-H', '-E']
      if (args.caseInsensitive === true) {
        parts.push('-i')
      }
      if (args.filesOnly === true) {
        parts.push('-l')
      }
      const context = args.contextLines
      if (typeof context === 'number' && context > 0 && args.filesOnly !== true) {
        parts.push(`-C ${Math.floor(context)}`)
      }
      const glob = args.glob as string | undefined
      if (glob) {
        parts.push(`--include=${shellQuote(glob)}`)
      }
      if (searchSkipsExcludedDirs(args, resolveRemoteFilePath(searchPath, cwd))) {
        parts.push(...SEARCH_EXCLUDED_DIRS.map((dir) => `--exclude-dir=${shellQuote(dir)}`))
      }
      parts.push('--', shellQuote(pattern), shellQuote(searchPath))
      const command = `${parts.join(' ')} | head -c ${SEARCH_BYTE_CAP}; true`
      const output = await remoteExec(ctx, command, cwd ? { cwd } : undefined)
      return renderSearchResult(output, searchLimit(args))
    },

    // ── write (remote) ───────────────────────────────────────────────
    remote_write: withApprovalRequired(
      async (args) => {
        const filePath = args.path as string | undefined
        const content = args.content as string | undefined
        if (!filePath || content === undefined) {
          fail(-32602, 'Missing required params: path, content')
        }
        const { ctx } = await resolveTerminalContext(args)
        const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)
        await writeRemoteFileExact(ctx, resolvedPath, content)
        return textResult(`The file ${resolvedPath} has been written.`)
      },
      { view: 'remote_write' },
    ),

    // ── edit (remote) ────────────────────────────────────────────────
    remote_edit: withApprovalRequired(
      async (args) => {
        const filePath = args.path as string | undefined
        const oldString = args.oldString as string | undefined
        const newString = args.newString as string | undefined
        if (!filePath || oldString === undefined || newString === undefined) {
          fail(-32602, 'Missing required params: path, oldString, newString')
        }
        if (oldString === newString) {
          fail(-32602, 'oldString and newString must differ')
        }
        const replaceAll = Boolean(args.replaceAll)
        const { ctx } = await resolveTerminalContext(args)
        const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)

        const content = await remoteExec(ctx, `cat ${shellQuote(resolvedPath)}`)
        const updated = replaceExact(content, { oldString, newString, replaceAll }, 'file')

        await writeRemoteFileExact(ctx, resolvedPath, updated)
        return textResult(`The file ${resolvedPath} has been updated successfully.`)
      },
      { view: 'remote_edit' },
    ),

    // ── exec (remote) ────────────────────────────────────────────────
    remote_exec: withApprovalRequired(
      async (args) => {
        const command = args.command as string | undefined
        if (!command) {
          fail(-32602, 'Missing required param: command')
        }
        const cwd = args.cwd as string | undefined
        const { ctx } = await resolveTerminalContext(args)
        const effectiveCwd = cwd
          ? resolveRemoteFilePath(cwd, ctx.cwd as string | undefined)
          : (ctx.cwd as string | undefined)
        const env = await resolveSecretsEnv(args.secrets as string[] | undefined)
        const output = await remoteExec(ctx, command, { cwd: effectiveCwd, env })
        return textResult(output)
      },
      { view: 'remote_exec' },
    ),

    // ── script (remote) ──────────────────────────────────────────────
    remote_script: withApprovalRequired(
      async (args) => {
        const script = args.script as string | undefined
        if (!script) {
          fail(-32602, 'Missing required param: script')
        }
        const scriptArgs = (args.args as string[] | undefined) ?? []
        const cwd = args.cwd as string | undefined
        const { ctx } = await resolveTerminalContext(args)
        const effectiveCwd = cwd
          ? resolveRemoteFilePath(cwd, ctx.cwd as string | undefined)
          : (ctx.cwd as string | undefined)
        const env = await resolveSecretsEnv(args.secrets as string[] | undefined)
        const tmpPath = `/tmp/opencroft-script-${crypto.randomUUID()}.sh`
        try {
          await writeRemoteFileExact(ctx, tmpPath, script)
          const argv = scriptArgs.map(shellQuote).join(' ')
          const output = await remoteExec(
            ctx,
            `bash ${shellQuote(tmpPath)} ${argv}; rc=$?; rm -f ${shellQuote(tmpPath)}; exit $rc`,
            { cwd: effectiveCwd, env },
          )
          return textResult(output)
        } catch (err) {
          // The happy path's `rm -f` never runs if the write itself failed (e.g. verification
          // mismatch) or the exec command never reached the remote — best-effort clean up here too,
          // otherwise a failed run leaves an orphaned script file in /tmp on every retry.
          try {
            await remoteExec(ctx, `rm -f ${shellQuote(tmpPath)}`, effectiveCwd ? { cwd: effectiveCwd } : undefined)
          } catch {
            /* best-effort; if the remote is unreachable there's nothing left to clean up */
          }
          throw err
        }
      },
      { view: 'remote_script' },
    ),

    // ── list_actions ─────────────────────────────────────────────────
    list_actions: async (args) => {
      const nodeId = args.nodeId as string | undefined
      if (!nodeId) {
        fail(-32602, 'Missing required param: nodeId')
      }
      const actions = await listNodeActionsImpl(nodeId)
      return textResult(JSON.stringify(actions, null, 2))
    },

    // ── call ─────────────────────────────────────────────────────────
    call: withApprovalRequired(
      async (args) => {
        const nodeId = args.nodeId as string | undefined
        const action = args.action as string | undefined
        if (!nodeId || !action) {
          fail(-32602, 'Missing required params: nodeId, action')
        }
        const params = (args.params as Record<string, unknown> | undefined) ?? {}
        const result = await dispatchNodeActionImpl({ nodeId, actionId: action, params })
        const text = result === undefined ? `Action ${action} completed.` : JSON.stringify(result, null, 2)
        return textResult(text)
      },
      { view: 'call' },
    ),

    // ── ask_user ──────────────────────────────────────────────────────────
    ask_user: async (args) => {
      const rawQuestions = args.questions as Array<Record<string, unknown>> | undefined
      if (!rawQuestions || !Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        fail(-32602, 'Missing required param: questions (non-empty array)')
      }
      if (rawQuestions.length > 5) {
        fail(-32602, 'Too many questions (max 5)')
      }

      const questions = rawQuestions.map((q) => ({
        title: String(q.title ?? ''),
        question: String(q.question ?? ''),
        options: (Array.isArray(q.options) ? q.options : []).map(String).slice(0, 5),
        multiple: Boolean(q.multiple),
      }))

      if (questions.some((q) => !q.title || !q.question || q.options.length === 0)) {
        fail(-32602, 'Each question must have title, question, and at least 1 option')
      }

      const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined
      const id = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

      const answers = await askUserStore.add({
        id,
        questions,
        spaceId,
        createdAt: Date.now(),
      })

      const lines = questions.map((q) => {
        const answer = answers[q.title] ?? ''
        return `"${q.question}"="${answer}"`
      })
      return textResult(`User answered to your questions:\n${lines.join('\n')}`)
    },

    // ── MCP servers ───────────────────────────────────────────────────────
    mcp_list: async () => {
      const servers = await readMcpServers()
      return textResult(JSON.stringify(servers.map(redactMcpServer), null, 2))
    },

    mcp_set: withApprovalRequired(async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const servers = await readMcpServers()
      const idx = servers.findIndex((s) => s.name === name)
      // A name already claimed by an MCP Connection node has its own reachable
      // path and needs no global entry — refuse rather than let the global list
      // and the node drift into two different definitions of the same name.
      // Updating an entry that's already global (idx >= 0) is unaffected.
      if (idx < 0 && (await isConnectionNodeName(name))) {
        fail(
          -32602,
          `"${name}" is an MCP Connection node's own name — it's already reachable and doesn't need a global entry.`,
        )
      }
      const config = mcpConfigFromArgs(args, idx >= 0 ? servers[idx] : undefined)
      if (idx >= 0) {
        servers[idx] = config
      } else {
        servers.push(config)
      }
      await writeMcpServers(servers)
      await agentClient.refreshMcpServers()
      return textResult(`MCP server "${config.name}" ${idx >= 0 ? 'updated' : 'created'}.`)
    }),

    mcp_remove: withApprovalRequired(async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name) {
        fail(-32602, 'Missing required param: name')
      }
      const servers = await readMcpServers()
      const next = servers.filter((s) => s.name !== name)
      if (next.length === servers.length) {
        fail(-32602, `No MCP server named "${name}"`)
      }
      await writeMcpServers(next)
      await agentClient.refreshMcpServers()
      return textResult(`MCP server "${name}" removed.`)
    }),

    mcp_test: async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!name) {
        fail(-32602, 'Missing required param: name')
      }
      const hasInline = ['transport', 'url', 'command', 'args', 'headers', 'env'].some((k) => args[k] !== undefined)
      let config: McpServerConfig
      if (hasInline) {
        config = mcpConfigFromArgs(args)
      } else {
        const existing = (await readMcpServers()).find((s) => s.name === name)
        if (!existing) {
          fail(-32602, `No MCP server named "${name}" — pass a full config to test an unsaved one`)
        }
        config = existing
      }
      return textResult(JSON.stringify(await checkMcpServer(config), null, 2))
    },

    // ── Skills ──────────────────────────────────────────────────────────────
    ...skillToolHandlers,
  }
}

const handlers = buildHandlers()

function rejectionResult(reason: string): Record<string, unknown> {
  const text = reason
    ? `The tool use was rejected. The user provided the following reason for the rejection: ${reason}`
    : 'The tool use was rejected by the user.'
  return { content: [{ type: 'text' as const, text }], isError: true }
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  opts: ToolCallOptions = {},
): Promise<Record<string, unknown>> {
  const start = Date.now()
  const handler = handlers[name]
  if (!handler) {
    const staticNames = new Set(toolDefinitions.map((t) => t.name))
    const extensionDef = (await getExtensionToolDefinitions(staticNames)).find((t) => t.name === name)
    if (extensionDef) {
      const approvalRequired = extensionDef.requireApproval && !isYoloMode() && !opts.internal
      try {
        if (approvalRequired) {
          const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined
          await awaitApproval({ tool: name, args, signal: opts.signal, spaceId })
        }
        const result = await executeExtensionTool(extensionDef.extensionId, name, args)
        await recordAudit({
          tool: name,
          args,
          result,
          status: approvalRequired ? 'approved' : 'auto-approved',
          durationMs: Date.now() - start,
        })
        return result
      } catch (e) {
        if (e instanceof ApprovalRejectedError) {
          await recordAudit({
            tool: name,
            args,
            error: e.reason || '(no reason)',
            status: 'rejected',
            durationMs: Date.now() - start,
          })
          return rejectionResult(e.reason)
        }
        const err = e as { message?: string }
        await recordAudit({
          tool: name,
          args,
          error: err.message ?? String(e),
          status: 'error',
          durationMs: Date.now() - start,
        })
        throw e
      }
    }

    // Fall back to graph-defined agent tools
    const execResult = await executeAgentTool(name, args, opts)
    await recordAudit({
      tool: name,
      args,
      result: execResult.result as Record<string, unknown>,
      status: execResult.requiredApproval ? 'approved' : 'auto-approved',
      durationMs: Date.now() - start,
    })
    return execResult.result as Record<string, unknown>
  }
  const meta = getApprovalMeta(handler)
  const approvalRequired = Boolean(meta) && !isYoloMode() && !opts.internal
  try {
    if (approvalRequired) {
      const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined
      await awaitApproval({ tool: name, args, view: meta?.view, signal: opts.signal, spaceId })
    }
    const result = await handler(args)
    await recordAudit({
      tool: name,
      args,
      result,
      status: approvalRequired ? 'approved' : 'auto-approved',
      durationMs: Date.now() - start,
    })
    return result
  } catch (e) {
    if (e instanceof ApprovalRejectedError) {
      await recordAudit({
        tool: name,
        args,
        error: e.reason || '(no reason)',
        status: 'rejected',
        durationMs: Date.now() - start,
      })
      return rejectionResult(e.reason)
    }
    const err = e as { message?: string }
    await recordAudit({
      tool: name,
      args,
      error: err.message ?? String(e),
      status: 'error',
      durationMs: Date.now() - start,
    })
    throw e
  }
}
