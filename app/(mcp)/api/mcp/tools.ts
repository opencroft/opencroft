/**
 * MCP tool definitions and handlers for the App Dashboard.
 *
 * Graph tools are scoped by `space` (slug).
 * If omitted, the active space is used. Extension tools operate on v2
 * local extensions (folders under `data/extensions/local/<slug>/`).
 * UI feedback (toasts, focus, comments) is broadcast via SSE.
 */

import fs from 'fs/promises';
import path from 'path';

import { ApprovalRejectedError, awaitApproval, getApprovalMeta, withApprovalRequired } from '@/app/(approvals)/_server/with-approval';
import { appendComment, createComment, readComments } from '@/app/(docs)/docs/_server/comments';
import { getDocsRoot } from '@/app/(docs)/docs/_server/docs-root';
import { searchDocsAtRoot } from '@/app/(docs)/docs/_server/search';
import { getGitFileAtRef } from '@/app/(docs)/docs/actions';
import {
  type InstallAuth,
  installExtensionFromUrl,
  uninstallExtension,
  updateInstalledExtension,
} from '@/app/(extension-editor)/_actions/installed-extensions-actions';
import {
  compileLocalExtension,
  createLocalExtension,
  deleteLocalExtension,
  getLocalExtension,
  listLocalExtensions,
  updateLocalExtension,
} from '@/app/(extension-editor)/_actions/local-extensions-actions';
import { invokeExtensionAction } from '@/app/(extension-runtime)/_server/actions';
import { getExtensionModule, loadAllManifests } from '@/app/(extension-runtime)/_server/loader';
import { dispatchNodeAction, listNodeActions } from '@/app/(extension-runtime)/_server/node-actions';
import type { ExtensionHandle } from '@/app/(extension-runtime)/_types';
import { recordAudit } from '@/app/(mcp)/api/mcp/audit';
import { isYoloMode } from '@/app/(mcp)/api/mcp/yolo';
import {
  createSpace,
  deleteSpace,
  findSpaceByNode,
  getActiveSpaceSlug,
  listSpaces,
  loadSpaceGraph,
  renameSpace,
  saveSpaceGraph,
} from '@/app/(space)/server/actions';
import { getSpacesRegistry } from '@/app/(space)/server/store';
import type { GraphData } from '@/app/(space)/server/types';
import { toastStore } from '@/lib/toast-store';
import { decrypt } from '@/server/crypto';
import { prisma } from '@/server/prisma';

const SPACE_PARAM = {
  space: {
    type: 'string',
    description: 'Space slug. Omit to target the currently active space.',
  },
};

const POSITION_SCHEMA = {
  type: 'object',
  description: 'Canvas position',
  properties: {
    x: { type: 'number', description: 'X coordinate' },
    y: { type: 'number', description: 'Y coordinate' },
  },
  required: ['x', 'y'],
};

const EDGE_ENDPOINT_DESCRIPTION = 'Node ID, optionally with handle after a slash (e.g. "node-id/out").';

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
    description: 'Find nodes whose name, type, or data fields match any of the given glob patterns (case-insensitive). Use `*` and `?` wildcards.',
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
    description: 'Get one or more nodes from a space by ID. Returns `{ found: Node[], missing: string[] }`. Each found node includes a `handles: { input, output }` map: `input[handleId]` is `"node-id/handle-id"` for the connected source or `null`, `output[handleId]` is an array of connected target endpoints (empty if unconnected). Dynamic source handles are expanded to live ids (e.g. application nodes expose one `instance-terminal-<containerId>` per running instance).',
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
    description: 'Create one or more nodes in a space. Each `type` must match a registered extension typeId (e.g. "server", "docker-service", "application").',
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
              data: { type: 'object', description: 'Initial node data (shape depends on the extension)' },
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
    description: "Update nodes' data and/or position (shallow merge). For long or multi-line string fields, prefer write_node_property / edit_node_property.",
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
              data: { type: 'object', description: "Partial data to merge into the node's data" },
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
    description: 'Overwrite a string property on a node by dot path (e.g. "script"). Preferred over update_nodes for multi-line strings.',
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
    description: 'Replace an exact string inside a node\'s string property at a dot path. Preferred over update_nodes for targeted edits in multi-line strings. Fails if oldString is not unique unless replaceAll is true.',
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
    description: 'Focus the camera on a node and select it. If the node lives in a different space, the UI switches to it first. If `comment` is provided, also attach a floating comment bubble to the node.',
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
    description: 'Attach floating comment bubbles to one or more nodes. Each node has at most one comment — subsequent calls replace the previous message.',
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
    description: 'List all local extensions. Each one is a folder under data/extensions/local/<slug>/ containing extension.json and source files. Built-in extensions are bundled with the app and not listed here.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'get_extension',
    description: 'Get a single local extension by its id (e.g. "local/my-node"). Returns the parsed manifest plus all source files.',
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
    description: 'Create a new local extension on disk. Writes files under data/extensions/local/<slug>/. At minimum must include extension.json and src/client.tsx. The manifest.id must be "local/<slug>" and match the slug used in the folder. Client source must use `export default defineExtension({ manifest: { id }, nodes: [...] })` from "@ext/host".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        files: {
          type: 'object',
          description: 'Map of relative file paths to content. Keys are paths relative to the extension folder (e.g. "extension.json", "src/client.tsx", "server/index.ts", "src/nodes/helper.ts"). At minimum must include "extension.json" and "src/client.tsx".',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['files'],
    },
  },
  {
    name: 'update_extension',
    description: 'Update files of an existing local extension. Replaces all provided files. Omitted files are left unchanged.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The local extension id (must start with "local/")' },
        files: {
          type: 'object',
          description: 'Map of relative file paths to content. Only the provided files will be updated; existing files not in the map are preserved. To delete a file, set its content to empty string and it will be removed.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['extensionId', 'files'],
    },
  },
  {
    name: 'delete_extension',
    description: 'Uninstall a local extension by removing its folder under data/extensions/local/. Nodes on the canvas that reference its typeId will render as "Unknown extension" until refreshed.',
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
    description: 'Manually trigger compilation (esbuild) of a local extension. Returns build result with errors and warnings. Useful after direct file edits (e.g. docker cp) that bypass the normal update flow.',
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
    description: 'Install an extension from a public Git repository (GitHub, GitLab, Gitea, Bitbucket, any git remote). Clones at the latest tag by default (falls back to default branch HEAD if no tags). Runs `npm install` if the repo has a package.json. Stored under data/extensions/installed/<slug>/. Resulting id is "installed/<slug>".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Repository: "owner/repo" (assumes github.com) or full URL (e.g. https://gitlab.com/group/repo).' },
        ref: { type: 'string', description: 'Optional tag or branch to install. Defaults to latest semver tag, or default branch HEAD.' },
        auth: {
          type: 'object',
          description: 'Optional auth for private repos. Pulls "token" (required) and "username" (optional, defaults to x-access-token) from the named Secrets Store.',
          properties: {
            storeId: { type: 'string', description: 'Secrets Store node id holding the credentials.' },
            tokenKey: { type: 'string', description: 'Secret key for the token. Defaults to "token".' },
            usernameKey: { type: 'string', description: 'Secret key for the username. Defaults to "username".' },
          },
          required: ['storeId'],
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'extension_update',
    description: 'Re-install an installed extension at a new (or same) ref. Pulls the latest tag from the remote unless a ref is given. Reuses the auth originally configured at install time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The installed extension id (must start with "installed/").' },
        ref: { type: 'string', description: 'Optional tag or branch. Defaults to the latest semver tag from the remote.' },
      },
      required: ['extensionId'],
    },
  },
  {
    name: 'extension_remove',
    description: 'Uninstall an installed extension. Removes the entire data/extensions/installed/<slug>/ folder including source, sidecar, and bundle. Cannot be undone — re-install via extension_install to restore.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        extensionId: { type: 'string', description: 'The installed extension id (must start with "installed/").' },
      },
      required: ['extensionId'],
    },
  },

  // ── Docs ──────────────────────────────────────────────────────────
  {
    name: 'doc_list_namespaces',
    description: 'List every Documentation node available as a namespace. Use to discover which `namespace` value to pass to other doc_* tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'doc_search',
    description: 'Search committed (HEAD) markdown content in a documentation namespace. Returns matching files with line snippets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Documentation namespace (slug). Use doc_list_namespaces to discover.' },
        pattern: { type: 'string', description: 'Regex pattern (case-insensitive).' },
        maxResults: { type: 'number', description: 'Maximum matches to return (default 50).' },
      },
      required: ['namespace', 'pattern'],
    },
  },
  {
    name: 'doc_read',
    description: 'Read the content of a doc by its relative path within a namespace (e.g. "guides/intro.md"). Paths must end with .md. Optional offset/limit slice the result by 1-indexed line.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Documentation namespace (slug).' },
        path: { type: 'string', description: 'Relative path within the namespace.' },
        offset: { type: 'number', description: '1-indexed line to start from. Default 1.' },
        limit: { type: 'number', description: 'Number of lines to return. Default: read to end.' },
      },
      required: ['namespace', 'path'],
    },
  },
  {
    name: 'doc_edit',
    description: 'Replace an exact string in a doc within a namespace. Fails if oldString is not unique unless replaceAll is true. Mirrors the behavior of the regular Edit tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Documentation namespace (slug).' },
        path: { type: 'string', description: 'Relative path within the namespace.' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['namespace', 'path', 'oldString', 'newString'],
    },
  },
  {
    name: 'doc_write',
    description: 'Create or overwrite a doc within a namespace. Creates parent directories as needed. Path must end with .md.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Documentation namespace (slug).' },
        path: { type: 'string', description: 'Relative path within the namespace.' },
        content: { type: 'string', description: 'Full file content (UTF-8).' },
      },
      required: ['namespace', 'path', 'content'],
    },
  },
  {
    name: 'doc_reply',
    description: 'Post a reply to a comment thread anchored on a doc within a namespace. Use when responding to a user comment the agent was mentioned in.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Documentation namespace (slug).' },
        docPath: { type: 'string', description: 'Relative path of the doc the comment is anchored to.' },
        commentId: { type: 'string', description: 'The id of the comment being replied to.' },
        message: { type: 'string', description: 'Reply text.' },
        author: { type: 'string', description: 'Author label shown in the thread. Defaults to "agent".' },
      },
      required: ['namespace', 'docPath', 'commentId', 'message'],
    },
  },
  {
    name: 'doc_publish',
    description: 'Commit and push a single file in a documentation namespace. Other staged changes are not pulled into the commit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        namespace: { type: 'string', description: 'Documentation namespace (slug).' },
        path: { type: 'string', description: 'Relative path of the file to commit.' },
        message: { type: 'string', description: 'Git commit message.' },
      },
      required: ['namespace', 'path', 'message'],
    },
  },

  // ── Remote File & Exec Ops ──────────────────────────────────────────
  {
    name: 'remote_read',
    description: 'Read a file from a remote node. The target is a terminal-context output handle in "node-id/handle-id" format (e.g. "localhost_abc/terminal"). Output is line-numbered (cat -n style). Optional offset/limit slice by 1-indexed line.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        path: { type: 'string', description: 'Absolute file path on the remote node.' },
        offset: { type: 'number', description: '1-indexed line to start from. Default 1.' },
        limit: { type: 'number', description: 'Number of lines to return. Default: read to end.' },
        ...SPACE_PARAM,
      },
      required: ['target', 'path'],
    },
  },
  {
    name: 'remote_write',
    description: 'Write or overwrite a file on a remote node. The target is a terminal-context output handle in "node-id/handle-id" format.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        path: { type: 'string', description: 'Absolute file path on the remote node.' },
        content: { type: 'string', description: 'File content to write (UTF-8).' },
        ...SPACE_PARAM,
      },
      required: ['target', 'path', 'content'],
    },
  },
  {
    name: 'remote_edit',
    description: 'Replace an exact string in a remote file. Fails if oldString is not unique unless replaceAll is true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        path: { type: 'string', description: 'Absolute file path on the remote node.' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        ...SPACE_PARAM,
      },
      required: ['target', 'path', 'oldString', 'newString'],
    },
  },
  {
    name: 'remote_exec',
    description: 'Execute a shell command on a remote node. The target is a terminal-context output handle in "node-id/handle-id" format. Optionally inject secret values from any Secrets Store as env vars (reference them in the command via "$NAME").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description: 'Terminal-context output handle (format: "node-id/handle-id").',
        },
        command: { type: 'string', description: 'Shell command to execute.' },
        secrets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of secrets (keys in any Secrets Store) to decrypt and inject as env vars before the command runs. Reference them via "$NAME" inside the command. Values are never returned, only injected into the executor process.',
        },
        description: {
          type: 'string',
          description: 'Short, human-readable description of what the command does (5-10 words). Shown in the permission prompt UI.',
        },
        ...SPACE_PARAM,
      },
      required: ['target', 'command'],
    },
  },

  // ── Node Actions ────────────────────────────────────────────────────
  {
    name: 'list_actions',
    description: 'List the actions available on a node (e.g. start/stop/restart on Application, run on Script). Use this to discover what actions a node exposes before calling them.',
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
    description: 'Invoke an action on a node — equivalent to clicking the corresponding button in the UI. Same code path, no duplication. Use list_actions first to discover available action IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeId: { type: 'string', description: 'Target node ID.' },
        action: { type: 'string', description: 'Action ID from the node manifest (e.g. "start", "stop", "run").' },
        params: {
          type: 'object',
          description: 'Optional parameters for the action. Shape depends on the action.',
        },
      },
      required: ['nodeId', 'action'],
    },
  },
];

// ── Agent Tool: dynamic graph-defined tools ───────────────────────────

interface AgentToolNodeData {
  name: string;
  description: string;
  inputSchema: string;
  requireApproval: boolean;
}

export async function getAgentToolDefinitions() {
  const defs: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [];

  // Collect all existing static tool names to avoid collisions
  const staticNames = new Set(toolDefinitions.map((t) => t.name));

  try {
    const registry = getSpacesRegistry();
    await registry.ensureLoaded();

    for (const space of registry.list()) {
      const runtime = registry.getBySlug(space.slug);
      if (!runtime) {
        continue;
      }

      const nodes = runtime.graph.nodes as unknown as GraphNode[];
      for (const node of nodes) {
        if (node.type !== 'agent-tool') {
          continue;
        }

        const d = (node.data ?? {}) as unknown as AgentToolNodeData;
        const toolName = d.name?.trim();
        if (!toolName) {
          continue;
        }

        if (staticNames.has(toolName)) {
          continue;
        } // static tools win
        if (defs.some((x) => x.name === toolName)) {
          continue;
        } // first space wins

        let inputSchema: Record<string, unknown> = { type: 'object', properties: {} };
        try {
          inputSchema = JSON.parse(d.inputSchema || '{}');
        } catch {
          // skip invalid JSON schema
        }

        defs.push({
          name: toolName,
          description: d.description || `Agent tool: ${toolName}`,
          inputSchema: {
            type: 'object' as const,
            properties: {
              ...(inputSchema.properties as Record<string, unknown> ?? {}),
            },
          },
        });
      }
    }
  } catch {
    // If spaces can't load, just return empty
  }

  return defs;
}

/**
 * Execute an agent-tool node's connected handler script.
 * Returns the handler result or throws on error.
 */
interface AgentToolExecResult {
  result: Record<string, unknown>;
  requiredApproval: boolean;
}

export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AgentToolExecResult> {
  const registry = getSpacesRegistry();
  await registry.ensureLoaded();

  // Find the agent-tool node across all spaces
  for (const space of registry.list()) {
    const runtime = registry.getBySlug(space.slug);
    if (!runtime) {
      continue;
    }

    const nodes = runtime.graph.nodes as unknown as GraphNode[];
    const edges = runtime.graph.edges as unknown as StoredEdge[];

    const toolNode = nodes.find(
      (n) => n.type === 'agent-tool' && ((n.data ?? {}) as Record<string, unknown>).name === toolName,
    );
    if (!toolNode) {
      continue;
    }

    // Check requireApproval
    const d = (toolNode.data ?? {}) as unknown as AgentToolNodeData;
    const requiredApproval = d.requireApproval && !isYoloMode();
    if (requiredApproval) {
      await awaitApproval({ tool: toolName, args, view: 'default', signal, spaceId: space.slug });
    }

    // Find connected handler via exec-out edge
    const handlerEdge = edges.find(
      (e) => e.source === toolNode.id && e.sourceHandle === 'exec-out',
    );
    if (!handlerEdge) {
      return { result: textResult(`Agent tool "${toolName}" has no connected handler script.`), requiredApproval: false };
    }

    const handlerNode = nodes.find((n) => n.id === handlerEdge.target);
    if (!handlerNode) {
      return { result: textResult(`Agent tool "${toolName}": handler node not found.`), requiredApproval: false };
    }

    const language = (handlerNode.data as Record<string, unknown>)?.language as string | undefined;
    if (language !== 'python' && language !== 'node') {
      return { result: textResult(
        `Agent tool "${toolName}": handler must be Python or Node.js script, got ${language ?? 'none'}.`,
      ), requiredApproval: false };
    }

    const resolvedContexts = (handlerNode.data as Record<string, unknown>)?.__resolvedContexts as
      | Record<string, { value?: Record<string, unknown> }>
      | undefined;
    const terminalContext = resolvedContexts?.['ctx-in']?.value ?? { type: 'local' };

    // Build event for the handler
    const event = { params: args, context: { toolName: toolName } };

    // Resolve env: parse data.env (KEY=value lines) + decrypt data.secrets (key names)
    const handlerData = (handlerNode.data ?? {}) as Record<string, unknown>;
    const env: Record<string, string> = {};
    const envLines = ((handlerData.env as string | undefined) ?? '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    for (const line of envLines) {
      const eq = line.indexOf('=');
      if (eq > 0) {
        env[line.slice(0, eq).trim()] = line.slice(eq + 1);
      }
    }
    const secretNames = ((handlerData.secrets as string | undefined) ?? '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    for (const name of secretNames) {
      const row = await prisma.secret.findFirst({
        where: { key: name },
        orderBy: { updatedAt: 'desc' },
      });
      if (!row) {
        return { result: textResult(`Agent tool "${toolName}" error: secret "${name}" not found in any Secrets Store.`), requiredApproval };
      }
      env[name] = decrypt(row.value);
    }

    // Execute handler
    const result = await invokeExtensionAction('builtin/core', 'handler.run', [
      {
        script: ((handlerNode.data as Record<string, unknown>)?.script as string) ?? '',
        language,
        context: terminalContext,
        event,
        env,
      },
    ]) as { status?: number; headers?: Record<string, string>; body?: unknown; error?: string; logs?: string };

    if (result.error) {
      return { result: textResult(`Agent tool "${toolName}" error: ${result.error}`), requiredApproval };
    }

    if (typeof result.body === 'object' && result.body !== null) {
      return { result: textResult(JSON.stringify(result.body)), requiredApproval };
    }

    return { result: textResult(String(result.body ?? '')), requiredApproval };
  }

  throw { code: -32601, message: `Agent tool not found: ${toolName}` };
}

// ── Tool handler registry ──────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface GraphNode {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
}

interface StoredEdge extends Record<string, unknown> {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface ParsedEndpoint {
  nodeId: string;
  handle?: string;
}

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(code: number, message: string): never {
  throw { code, message };
}

async function resolveSpace(args: Record<string, unknown>): Promise<string> {
  const input = args.space as string | undefined;
  if (!input) {
    return getActiveSpaceSlug();
  }
  const spaces = await listSpaces();
  const bySlug = spaces.find((s) => s.slug === input);
  if (bySlug) {
    return bySlug.slug;
  }
  fail(-32602, `Space not found: ${input} (use a slug — see list_spaces)`);
}

async function loadOrFail(slug: string): Promise<GraphData> {
  const graph = await loadSpaceGraph(slug);
  if (!graph) {
    fail(-32602, `Space not found: ${slug}`);
  }
  return graph;
}

function broadcastGraphUpdated(spaceId: string): void {
  toastStore.broadcast({ type: 'graph_updated', spaceId });
}

function broadcastExtensionsUpdated(): void {
  toastStore.broadcast({ type: 'extensions_updated' });
}

function edgeMatches(edge: StoredEdge, endpoint: { source: ParsedEndpoint; target: ParsedEndpoint }): boolean {
  if (edge.source !== endpoint.source.nodeId || edge.target !== endpoint.target.nodeId) {
    return false;
  }
  if (endpoint.source.handle !== undefined && edge.sourceHandle !== endpoint.source.handle) {
    return false;
  }
  if (endpoint.target.handle !== undefined && edge.targetHandle !== endpoint.target.handle) {
    return false;
  }
  return true;
}

function parseEndpoint(raw: string): ParsedEndpoint {
  const i = raw.indexOf('/');
  if (i === -1) {
    return { nodeId: raw };
  }
  return { nodeId: raw.slice(0, i), handle: raw.slice(i + 1) };
}

function formatEndpoint(nodeId: string, handle?: string): string {
  return handle ? `${nodeId}/${handle}` : nodeId;
}

function edgeToApi(edge: StoredEdge): Record<string, unknown> {
  return {
    id: edge.id,
    source: formatEndpoint(edge.source, edge.sourceHandle),
    target: formatEndpoint(edge.target, edge.targetHandle),
  };
}

async function buildTypeNameMap(): Promise<Map<string, string>> {
  const manifests = await loadAllManifests();
  const map = new Map<string, string>();
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.typeId, node.name);
    }
  }
  return map;
}

async function buildTypeHandlesMap(): Promise<Map<string, ExtensionHandle[]>> {
  const manifests = await loadAllManifests();
  const map = new Map<string, ExtensionHandle[]>();
  for (const manifest of manifests) {
    for (const node of manifest.nodes ?? []) {
      map.set(node.typeId, node.handles ?? []);
    }
  }
  return map;
}

interface NodeHandlesView {
  input: Record<string, string | null>;
  output: Record<string, string[]>;
}

async function expandDynamicHandles(node: GraphNode, declared: ExtensionHandle[]): Promise<string[]> {
  if (node.type !== 'application') {
    return [];
  }
  const dynamic = declared.find((h) => h.dynamic && h.role === 'source');
  if (!dynamic) {
    return [];
  }
  const resolved = node.data?.['__resolvedContexts'] as Record<string, { sourceNodeId?: string }> | undefined;
  const dockerNodeId = resolved?.['docker-in']?.sourceNodeId;
  if (!dockerNodeId) {
    return [];
  }
  const service = (node.data?.['name'] as string) || node.id;
  try {
    const containers = await invokeExtensionAction('builtin/core', 'docker.ps', [{ dockerNodeId, service }]) as Array<{ id: string; name: string; running: boolean }>;
    return containers.filter((c) => c.running).map((c) => `${dynamic.id}${c.name || c.id}`);
  } catch (err) {
    console.error(`[mcp.expandDynamicHandles] failed for ${node.id}:`, err);
    return [];
  }
}

async function nodeHandles(
  node: GraphNode,
  edges: StoredEdge[],
  typeHandles: Map<string, ExtensionHandle[]>,
): Promise<NodeHandlesView> {
  const input: Record<string, string | null> = {};
  const output: Record<string, string[]> = {};
  const declared = node.type ? typeHandles.get(node.type) ?? [] : [];
  for (const h of declared) {
    if (h.role === 'target') {
      input[h.id] = null;
      continue;
    }
    if (h.dynamic) {
      continue;
    }
    output[h.id] = [];
  }
  for (const id of await expandDynamicHandles(node, declared)) {
    output[id] = [];
  }
  for (const edge of edges) {
    if (edge.target === node.id && edge.targetHandle) {
      input[edge.targetHandle] = formatEndpoint(edge.source, edge.sourceHandle);
      continue;
    }
    if (edge.source === node.id && edge.sourceHandle) {
      const list = output[edge.sourceHandle] ?? [];
      list.push(formatEndpoint(edge.target, edge.targetHandle));
      output[edge.sourceHandle] = list;
    }
  }
  return { input, output };
}

function nodeName(node: GraphNode, typeNames: Map<string, string>): string {
  if (node.type && typeNames.has(node.type)) {
    return typeNames.get(node.type)!;
  }
  return node.type ?? node.id;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${body}$`, 'i');
}

function globLiteral(pattern: string): string {
  const parts = pattern.split(/[*?]+/).filter(Boolean);
  return parts.reduce((best, p) => (p.length > best.length ? p : best), '');
}

function snippet(value: string, pattern: string, radius = 100): string {
  const literal = globLiteral(pattern);
  if (!literal) {
    return value.length <= radius * 2 ? value : `${value.slice(0, radius * 2)}…`;
  }
  const idx = value.toLowerCase().indexOf(literal.toLowerCase());
  if (idx === -1) {
    return value.length <= radius * 2 ? value : `${value.slice(0, radius * 2)}…`;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(value.length, idx + literal.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < value.length ? '…' : '';
  return prefix + value.slice(start, end) + suffix;
}

function walkLeaves(value: unknown, path: string, out: Map<string, string>): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkLeaves(item, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${k}` : k;
      walkLeaves(v, next, out);
    }
    return;
  }
  out.set(path, String(value));
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = cur[key];
    if (next === null || typeof next !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function requireArray<T = unknown>(value: unknown, name: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(-32602, `Missing required param: ${name} (non-empty array)`);
  }
  return value as T[];
}

// ── Remote ops helpers ────────────────────────────────────────────────────

const CORE_EXTENSION_ID = 'builtin/core';

export async function resolveTerminalContext(
  args: Record<string, unknown>,
): Promise<{ ctx: Record<string, unknown>; slug: string }> {
  const target = args.target as string | undefined;
  if (!target) {
    fail(-32602, 'Missing required param: target');
  }
  const ep = parseEndpoint(target);
  if (!ep.handle) {
    fail(-32602, 'target must include handle (format: "node-id/handle-id")');
  }
  const slug = await resolveSpace(args);
  const graph = await loadOrFail(slug);
  const node = graph.nodes.find(
    (n) => (n as { id?: string }).id === ep.nodeId,
  ) as GraphNode | undefined;
  if (!node) {
    fail(-32602, `Node not found: ${ep.nodeId}`);
  }
  if (!node.type) {
    fail(-32602, `Node ${ep.nodeId} has no type`);
  }

  const manifests = await loadAllManifests();
  const manifest = manifests.find((m) =>
    m.nodes?.some((n) => n.typeId === node.type),
  );
  if (!manifest) {
    fail(-32602, `No extension provides node type: ${node.type}`);
  }

  const mod = await getExtensionModule(manifest.id);
  if (!mod.exposeOutput) {
    fail(-32602, `Extension ${manifest.id} has no exposeOutput`);
  }

  const ctx = mod.exposeOutput(ep.handle, node.data ?? {}, node.type);
  if (ctx === undefined || ctx === null) {
    fail(-32602, `No context value for ${target}`);
  }

  return { ctx: ctx as Record<string, unknown>, slug };
}

export async function remoteExec(
  ctx: Record<string, unknown>,
  command: string,
): Promise<string> {
  const core = await getExtensionModule(CORE_EXTENSION_ID);
  const execFn = core.actions['terminal.exec'];
  if (!execFn) {
    fail(-32603, 'Core extension has no terminal.exec action');
  }
  return execFn(ctx, command) as Promise<string>;
}

export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

async function resolveSecretsForExec(names: string[] | undefined): Promise<string> {
  if (!names || names.length === 0) {
    return '';
  }
  const lines: string[] = [];
  for (const name of names) {
    const row = await prisma.secret.findFirst({
      where: { key: name },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row) {
      fail(-32602, `Secret "${name}" not found in any Secrets Store`);
    }
    const decrypted = decrypt(row.value);
    const b64 = Buffer.from(decrypted, 'utf8').toString('base64');
    lines.push(`export ${name}=$(echo ${b64} | base64 -d)`);
  }
  const prefix = lines.join('; ') + '; ';
  console.error('[resolveSecretsForExec] PREFIX FIRST 80:', prefix.slice(0, 80));
  console.error('[resolveSecretsForExec] PREFIX LEN:', prefix.length);
  return prefix;
}

function catN(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const lastLineNo = startLine + lines.length - 1;
  const width = String(lastLineNo).length;
  return lines
    .map((line, i) => String(startLine + i).padStart(width) + '\t' + line)
    .join('\n');
}

function sliceLines(content: string, offset?: number, limit?: number): string {
  if (offset == null && limit == null) {
    return content;
  }
  const lines = content.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit != null ? Math.min(lines.length, start + limit) : lines.length;
  return lines.slice(start, end).join('\n');
}

// ── Doc helpers ─────────────────────────────────────────────────────────

async function resolveDocPath(namespace: string, relative: string): Promise<string> {
  if (!relative.endsWith('.md')) {
    fail(-32602, 'Doc path must end with .md');
  }
  const root = await getDocsRoot(namespace);
  if (!root) {
    fail(-32602, `No documentation repository configured for namespace "${namespace}"`);
  }
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root)) {
    fail(-32602, 'Access denied');
  }
  return resolved;
}

async function findDocNodeIdForNamespace(namespace: string): Promise<string | null> {
  try {
    const mod = await getExtensionModule('builtin/core');
    const fn = mod.actions?.['docs.findDocNodeId'];
    if (!fn) {
      return null;
    }
    return (await fn({ namespace })) as string | null;
  } catch {
    return null;
  }
}


/** Best-effort git-add for the matching namespace's Documentation node. */
async function docsGitAdd(namespace: string, relativePath: string): Promise<void> {
  try {
    const nodeId = await findDocNodeIdForNamespace(namespace);
    if (!nodeId) {
      return;
    }
    const mod = await getExtensionModule('builtin/core');
    const addFn = mod.actions?.['docs.addFile'];
    if (!addFn) {
      return;
    }
    await addFn({ nodeId, filePath: relativePath });
  } catch {
    // best-effort — do not block doc operations if git-add fails
  }
}

function buildHandlers(): Record<string, ToolHandler> {
  return {
    // ── send_toast ──────────────────────────────────────────────────
    send_toast: async (args) => {
      const message = args.message as string | undefined;
      if (!message) {
        fail(-32602, 'Missing required param: message');
      }
      const type = (args.type as string) || 'info';
      const spaceId = args.space as string | undefined;
      toastStore.broadcast({
        type: 'toast',
        message,
        toastType: type as 'info' | 'success' | 'warning' | 'error',
        ...(spaceId ? { spaceId } : {}),
      });
      return textResult(`Toast sent: [${type}] ${message}`);
    },

    // ── list_spaces ─────────────────────────────────────────────────
    list_spaces: async () => {
      const spaces = await listSpaces();
      return textResult(JSON.stringify(spaces, null, 2));
    },

    // ── create_space ────────────────────────────────────────────────
    create_space: withApprovalRequired(async (args) => {
      const name = args.name as string | undefined;
      if (!name) {
        fail(-32602, 'Missing required param: name');
      }
      const space = await createSpace(name);
      return textResult(JSON.stringify(space, null, 2));
    }),

    // ── rename_space ────────────────────────────────────────────────
    rename_space: withApprovalRequired(async (args) => {
      const name = args.name as string | undefined;
      if (!args.space || !name) {
        fail(-32602, 'Missing required params: space, name');
      }
      const slug = await resolveSpace(args);
      const space = await renameSpace(slug, name);
      if (!space) {
        fail(-32602, `Space not found: ${slug}`);
      }
      return textResult(JSON.stringify(space, null, 2));
    }),

    // ── delete_space ────────────────────────────────────────────────
    delete_space: withApprovalRequired(async (args) => {
      if (!args.space) {
        fail(-32602, 'Missing required param: space');
      }
      const slug = await resolveSpace(args);
      const ok = await deleteSpace(slug);
      if (!ok) {
        fail(-32602, 'Cannot delete (not found or last remaining space)');
      }
      return textResult(`Space ${slug} deleted.`);
    }),

    // ── list_nodes ──────────────────────────────────────────────────
    list_nodes: async (args) => {
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const typeNames = await buildTypeNameMap();
      const entries = graph.nodes.map((n) => {
        const node = n as unknown as GraphNode;
        return { id: node.id, name: nodeName(node, typeNames) };
      });
      return textResult(JSON.stringify(entries, null, 2));
    },

    // ── find_nodes ──────────────────────────────────────────────────
    find_nodes: async (args) => {
      const patterns = requireArray<string>(args.patterns, 'patterns');
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const typeNames = await buildTypeNameMap();
      const regexes = patterns.map((p) => ({ pattern: p, regex: globToRegex(p) }));
      const results: Record<string, unknown>[] = [];
      for (const n of graph.nodes) {
        const node = n as unknown as GraphNode;
        const name = nodeName(node, typeNames);
        const hasName = name !== node.id && name !== node.type;
        const fields = new Map<string, string>();
        if (hasName) {
          fields.set('name', name);
        }
        if (node.type) {
          fields.set('type', node.type);
        }
        if (node.data) {
          walkLeaves(node.data, 'data', fields);
        }
        const matches: Record<string, string> = {};
        for (const [path, value] of fields) {
          for (const { pattern, regex } of regexes) {
            if (regex.test(value)) {
              matches[path] = snippet(value, pattern);
              break;
            }
          }
        }
        if (Object.keys(matches).length === 0) {
          continue;
        }
        const entry: Record<string, unknown> = { id: node.id };
        if (hasName) {
          entry.name = name;
        }
        if (node.type) {
          entry.type = node.type;
        }
        if (node.position) {
          entry.position = node.position;
        }
        entry.matches = matches;
        results.push(entry);
      }
      return textResult(JSON.stringify(results, null, 2));
    },

    // ── get_nodes ───────────────────────────────────────────────────
    get_nodes: async (args) => {
      const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds');
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const typeHandles = await buildTypeHandlesMap();
      const edges = graph.edges as StoredEdge[];
      const index = new Map<string, GraphNode>();
      for (const n of graph.nodes) {
        index.set((n as GraphNode).id, n as GraphNode);
      }
      const found: unknown[] = [];
      const missing: string[] = [];
      for (const id of nodeIds) {
        const node = index.get(id);
        if (node) {
          found.push({ ...node, handles: await nodeHandles(node, edges, typeHandles) });
          continue;
        }
        missing.push(id);
      }
      return textResult(JSON.stringify({ found, missing }, null, 2));
    },

    // ── create_nodes ────────────────────────────────────────────────
    create_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.nodes, 'nodes');
      for (const it of items) {
        if (!it.type || typeof it.type !== 'string') {
          fail(-32602, 'Each node must include a string "type"');
        }
      }
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      let maxY = graph.nodes.reduce((max, n) => {
        const py = (n as { position?: { y?: number } }).position?.y ?? 0;
        return Math.max(max, py);
      }, 0);
      const created: GraphNode[] = [];
      for (const it of items) {
        const userPos = it.position as { x: number; y: number } | undefined;
        if (userPos) {
          maxY = Math.max(maxY, userPos.y);
        } else {
          maxY += 150;
        }
        const position = userPos ?? { x: 100, y: maxY };
        const data = (it.data as Record<string, unknown>) ?? {};
        const node: GraphNode = {
          id: crypto.randomUUID(),
          type: it.type as string,
          position,
          data,
        };
        graph.nodes.push(node);
        created.push(node);
      }
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(JSON.stringify(created, null, 2));
    }),

    // ── update_nodes ────────────────────────────────────────────────
    update_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.updates, 'updates');
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const index = new Map<string, GraphNode>();
      for (const n of graph.nodes) {
        const node = n as unknown as GraphNode;
        index.set(node.id, node);
      }
      const missing: string[] = [];
      for (const it of items) {
        const nodeId = it.nodeId as string | undefined;
        if (!nodeId) {
          fail(-32602, 'Each update must include "nodeId"');
        }
        if (!index.has(nodeId)) {
          missing.push(nodeId);
        }
      }
      if (missing.length > 0) {
        fail(-32602, `Nodes not found: ${missing.join(', ')}`);
      }
      const updated: GraphNode[] = [];
      for (const it of items) {
        const node = index.get(it.nodeId as string)!;
        const data = it.data as Record<string, unknown> | undefined;
        if (data) {
          node.data = { ...(node.data ?? {}), ...data };
        }
        const position = it.position as { x: number; y: number } | undefined;
        if (position) {
          node.position = position;
        }
        updated.push(node);
      }
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(JSON.stringify(updated, null, 2));
    }, { view: 'update_nodes' }),

    // ── write_node_property ─────────────────────────────────────────
    write_node_property: withApprovalRequired(async (args) => {
      const nodeId = args.nodeId as string | undefined;
      const propPath = args.path as string | undefined;
      const value = args.value as string | undefined;
      if (!nodeId || !propPath || value === undefined) {
        fail(-32602, 'Missing required params: nodeId, path, value');
      }
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined;
      if (!node) {
        fail(-32602, `Node not found: ${nodeId}`);
      }
      if (!node.data) {
        node.data = {};
      }
      setByPath(node.data, propPath, value);
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(`Property ${propPath} on ${nodeId} written.`);
    }, { view: 'write_node_property' }),

    // ── edit_node_property ──────────────────────────────────────────
    edit_node_property: withApprovalRequired(async (args) => {
      const nodeId = args.nodeId as string | undefined;
      const propPath = args.path as string | undefined;
      const oldString = args.oldString as string | undefined;
      const newString = args.newString as string | undefined;
      if (!nodeId || !propPath || oldString === undefined || newString === undefined) {
        fail(-32602, 'Missing required params: nodeId, path, oldString, newString');
      }
      if (oldString === newString) {
        fail(-32602, 'oldString and newString must differ');
      }
      const replaceAll = Boolean(args.replaceAll);
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const node = graph.nodes.find((n) => (n as { id: string }).id === nodeId) as GraphNode | undefined;
      if (!node) {
        fail(-32602, `Node not found: ${nodeId}`);
      }
      const current = getByPath(node.data ?? {}, propPath);
      if (typeof current !== 'string') {
        fail(-32602, `Property ${propPath} is not a string`);
      }
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        fail(-32602, 'oldString not found in property');
      }
      if (occurrences > 1 && !replaceAll) {
        fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`);
      }
      const updated = replaceAll
        ? current.split(oldString).join(newString)
        : current.replace(oldString, newString);
      if (!node.data) {
        node.data = {};
      }
      setByPath(node.data, propPath, updated);
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(`Property ${propPath} on ${nodeId} updated.`);
    }, { view: 'edit_node_property' }),

    // ── delete_nodes ────────────────────────────────────────────────
    delete_nodes: withApprovalRequired(async (args) => {
      const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds');
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const existing = new Set(graph.nodes.map((n) => (n as { id: string }).id));
      const missing = nodeIds.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        fail(-32602, `Nodes not found: ${missing.join(', ')}`);
      }
      const targets = new Set(nodeIds);
      graph.nodes = graph.nodes.filter((n) => !targets.has((n as { id: string }).id));
      const beforeEdges = graph.edges.length;
      graph.edges = graph.edges.filter((e) => {
        const edge = e as { source: string; target: string };
        return !targets.has(edge.source) && !targets.has(edge.target);
      });
      const removedEdges = beforeEdges - graph.edges.length;
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(JSON.stringify({ deleted: nodeIds, removedEdges }, null, 2));
    }),

    // ── list_edges ──────────────────────────────────────────────────
    list_edges: async (args) => {
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const edges = graph.edges.map((e) => edgeToApi(e as StoredEdge));
      return textResult(JSON.stringify(edges, null, 2));
    },

    // ── connect_nodes ───────────────────────────────────────────────
    connect_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.edges, 'edges');
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const nodeIds = new Set(graph.nodes.map((n) => (n as { id: string }).id));
      const parsed = items.map((it) => {
        if (!it.source || !it.target || typeof it.source !== 'string' || typeof it.target !== 'string') {
          fail(-32602, 'Each edge must include "source" and "target"');
        }
        const source = parseEndpoint(it.source as string);
        const target = parseEndpoint(it.target as string);
        if (!nodeIds.has(source.nodeId)) {
          fail(-32602, `Source node not found: ${source.nodeId}`);
        }
        if (!nodeIds.has(target.nodeId)) {
          fail(-32602, `Target node not found: ${target.nodeId}`);
        }
        const exists = (graph.edges as StoredEdge[]).some((e) => edgeMatches(e, { source, target }));
        if (exists) {
          fail(-32602, `Edge already exists: ${it.source} -> ${it.target}`);
        }
        return { source, target };
      });
      const created: Record<string, unknown>[] = [];
      for (const p of parsed) {
        const edge: StoredEdge = {
          id: crypto.randomUUID(),
          source: p.source.nodeId,
          target: p.target.nodeId,
        };
        if (p.source.handle) {
          edge.sourceHandle = p.source.handle;
        }
        if (p.target.handle) {
          edge.targetHandle = p.target.handle;
        }
        graph.edges.push(edge);
        created.push(edgeToApi(edge));
      }
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(JSON.stringify(created, null, 2));
    }),

    // ── disconnect_nodes ────────────────────────────────────────────
    disconnect_nodes: withApprovalRequired(async (args) => {
      const items = requireArray<Record<string, unknown>>(args.edges, 'edges');
      const slug = await resolveSpace(args);
      const graph = await loadOrFail(slug);
      const indices: number[] = [];
      for (const it of items) {
        if (!it.source || !it.target || typeof it.source !== 'string' || typeof it.target !== 'string') {
          fail(-32602, 'Each edge must include "source" and "target"');
        }
        const source = parseEndpoint(it.source as string);
        const target = parseEndpoint(it.target as string);
        const idx = (graph.edges as StoredEdge[]).findIndex(
          (e, i) => !indices.includes(i) && edgeMatches(e, { source, target }),
        );
        if (idx === -1) {
          fail(-32602, `Edge not found: ${it.source} -> ${it.target}`);
        }
        indices.push(idx);
      }
      indices.sort((a, b) => b - a);
      const removed: string[] = [];
      for (const idx of indices) {
        const edge = graph.edges.splice(idx, 1)[0] as StoredEdge;
        removed.push(edge.id);
      }
      await saveSpaceGraph(slug, graph);
      broadcastGraphUpdated(slug);
      return textResult(JSON.stringify({ removed }, null, 2));
    }),

    // ── focus_node ──────────────────────────────────────────────────
    focus_node: async (args) => {
      const nodeId = args.nodeId as string | undefined;
      if (!nodeId) {
        fail(-32602, 'Missing required param: nodeId');
      }
      const space = await findSpaceByNode(nodeId);
      if (!space) {
        fail(-32602, `Node not found in any space: ${nodeId}`);
      }
      toastStore.broadcast({ type: 'open_space', slug: space.slug, nodeId });
      toastStore.broadcast({ type: 'focus_node', nodeId, spaceId: space.slug });
      const comment = args.comment as string | undefined;
      if (!comment) {
        return textResult(`Focused on node ${nodeId} in space ${space.slug}`);
      }
      toastStore.broadcast({ type: 'comment', message: comment, nodeId, spaceId: space.slug });
      return textResult(JSON.stringify({ nodeId, comment, space: space.slug }));
    },

    // ── comment_nodes ───────────────────────────────────────────────
    comment_nodes: async (args) => {
      const items = requireArray<Record<string, unknown>>(args.comments, 'comments');
      const entries: { nodeId: string; message: string }[] = [];
      for (const it of items) {
        const nodeId = it.nodeId as string | undefined;
        const message = it.message as string | undefined;
        if (!nodeId || !message) {
          fail(-32602, 'Each comment must include "nodeId" and "message"');
        }
        entries.push({ nodeId, message });
      }
      const slug = await resolveSpace(args);
      for (const entry of entries) {
        toastStore.broadcast({ type: 'comment', message: entry.message, nodeId: entry.nodeId, spaceId: slug });
      }
      return textResult(JSON.stringify(entries, null, 2));
    },

    // ── uncomment_nodes ─────────────────────────────────────────────
    uncomment_nodes: async (args) => {
      const nodeIds = requireArray<string>(args.nodeIds, 'nodeIds');
      const slug = await resolveSpace(args);
      for (const nodeId of nodeIds) {
        toastStore.broadcast({ type: 'clear_comment', nodeId, spaceId: slug });
      }
      return textResult(JSON.stringify({ cleared: nodeIds }, null, 2));
    },

    // ── list_extensions ─────────────────────────────────────────────
    list_extensions: async () => {
      const records = await listLocalExtensions();
      return textResult(JSON.stringify(records, null, 2));
    },

    // ── get_extension ───────────────────────────────────────────────
    get_extension: async (args) => {
      const extensionId = args.extensionId as string | undefined;
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId');
      }
      const record = await getLocalExtension(extensionId);
      if (!record) {
        fail(-32602, `Extension not found: ${extensionId}`);
      }
      return textResult(JSON.stringify(record, null, 2));
    },

    // ── create_extension ────────────────────────────────────────────
    create_extension: withApprovalRequired(async (args) => {
      const filesRaw = args.files as Record<string, unknown> | undefined;
      if (!filesRaw || typeof filesRaw !== 'object') {
        fail(-32602, 'Missing required param: files');
      }
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(filesRaw)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          fail(-32602, `Invalid file entry: ${k}`);
        }
        files[k] = v;
      }
      if (!files['extension.json']) {
        fail(-32602, 'files must include "extension.json"');
      }
      const record = await createLocalExtension(files);
      broadcastExtensionsUpdated();
      return textResult(`Extension ${record.id} installed with ${Object.keys(files).length} files.`);
    }),

    // ── update_extension ────────────────────────────────────────────
    update_extension: withApprovalRequired(async (args) => {
      const extensionId = args.extensionId as string | undefined;
      const filesRaw = args.files as Record<string, unknown> | undefined;
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId');
      }
      if (!filesRaw || typeof filesRaw !== 'object') {
        fail(-32602, 'Missing required param: files');
      }
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(filesRaw)) {
        if (typeof k !== 'string' || typeof v !== 'string') {
          fail(-32602, `Invalid file entry: ${k}`);
        }
        files[k] = v;
      }
      await updateLocalExtension(extensionId, files);
      broadcastExtensionsUpdated();
      return textResult(`Extension ${extensionId} updated with ${Object.keys(files).length} files.`);
    }),

    // ── delete_extension ───────────────────�����────────────────────────
    delete_extension: withApprovalRequired(async (args) => {
      const extensionId = args.extensionId as string | undefined;
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId');
      }
      await deleteLocalExtension(extensionId);
      broadcastExtensionsUpdated();
      return textResult(`Extension ${extensionId} uninstalled.`);
    }),

    // ── extension_install ────────────────────────────────────────────
    extension_install: withApprovalRequired(async (args) => {
      const url = args.url as string | undefined;
      if (!url) {
        fail(-32602, 'Missing required param: url');
      }
      const ref = args.ref as string | undefined;
      const authRaw = args.auth as { storeId?: string; tokenKey?: string; usernameKey?: string } | undefined;
      let auth: InstallAuth | undefined;
      if (authRaw) {
        if (!authRaw.storeId) {
          fail(-32602, 'auth.storeId is required when auth is provided');
        }
        auth = {
          type: 'secret',
          storeId: authRaw.storeId,
          tokenKey: authRaw.tokenKey,
          usernameKey: authRaw.usernameKey,
        };
      }
      const record = await installExtensionFromUrl({ url, ref, auth });
      broadcastExtensionsUpdated();
      return textResult(`Installed ${record.id} at ${record.sidecar.ref} from ${record.sidecar.source.url}.`);
    }),

    // ── extension_update ─────────────────────────────────────────────
    extension_update: withApprovalRequired(async (args) => {
      const extensionId = args.extensionId as string | undefined;
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId');
      }
      const ref = args.ref as string | undefined;
      const record = await updateInstalledExtension(extensionId, ref);
      broadcastExtensionsUpdated();
      return textResult(`Updated ${record.id} to ${record.sidecar.ref}.`);
    }),

    // ── extension_remove ─────────────────────────────────────────────
    extension_remove: withApprovalRequired(async (args) => {
      const extensionId = args.extensionId as string | undefined;
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId');
      }
      await uninstallExtension(extensionId);
      broadcastExtensionsUpdated();
      return textResult(`Uninstalled ${extensionId}.`);
    }),

    // ── compile_extension ────────────────────────────────────────────
    compile_extension: withApprovalRequired(async (args) => {
      const extensionId = args.extensionId as string | undefined;
      if (!extensionId) {
        fail(-32602, 'Missing required param: extensionId');
      }
      try {
        const result = await compileLocalExtension(extensionId);
        const parts: string[] = [];
        parts.push(`Build ${result.success ? '✅ succeeded' : '❌ failed'}`);
        if (result.errors.length > 0) {
          parts.push(`\nErrors (${result.errors.length}):`);
          for (const e of result.errors) {
            const loc = e.line ? `${e.file}:${e.line}:${e.column}` : e.file;
            parts.push(`  ${loc}: ${e.message}`);
          }
        }
        if (result.warnings.length > 0) {
          parts.push(`\nWarnings (${result.warnings.length}):`);
          for (const w of result.warnings) {
            const loc = w.line ? `${w.file}:${w.line}:${w.column}` : w.file;
            parts.push(`  ${loc}: ${w.message}`);
          }
        }
        if (result.success) {
          broadcastExtensionsUpdated();
        }
        return textResult(parts.join('\n'));
      } catch (err) {
        return textResult(`Compilation error: ${String(err)}`);
      }
    }),

    // ── doc_list_namespaces ─────────────────────────────────────────
    doc_list_namespaces: async () => {
      const mod = await getExtensionModule('builtin/core');
      const fn = mod.actions?.['docs.listNamespaces'];
      if (!fn) {
        return textResult('[]');
      }
      const list = await fn() as Array<{ id: string; namespace: string; name: string }>;
      return textResult(JSON.stringify(list, null, 2));
    },

    // ── doc_search ──────────────────────────────────────────────────
    // Searches committed (HEAD) content via `git grep` for HEAD-only
    // correctness and O(repo) speed.
    doc_search: async (args) => {
      const namespace = args.namespace as string | undefined;
      const pattern = args.pattern as string | undefined;
      if (!namespace) {
        fail(-32602, 'Missing required param: namespace');
      }
      if (!pattern) {
        fail(-32602, 'Missing required param: pattern');
      }
      const maxResults = (args.maxResults as number | undefined) ?? 50;
      const root = await getDocsRoot(namespace);
      if (!root) {
        return textResult('[]');
      }
      const enriched = await searchDocsAtRoot(root, pattern, maxResults);
      return textResult(JSON.stringify(enriched, null, 2));
    },

    // ── doc_read ────────────────────────────────────────────────────
    // Prefers committed (HEAD) content — agents see the published version.
    // Falls back to working tree only if HEAD has no such file.
    doc_read: async (args) => {
      const namespace = args.namespace as string | undefined;
      const relative = args.path as string | undefined;
      if (!namespace) {
        fail(-32602, 'Missing required param: namespace');
      }
      if (!relative) {
        fail(-32602, 'Missing required param: path');
      }
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const resolved = await resolveDocPath(namespace, relative);
      const head = await getGitFileAtRef(namespace, relative, 'HEAD');
      if (head !== null) {
        return textResult(sliceLines(head, offset, limit));
      }
      try {
        const content = await fs.readFile(resolved, 'utf-8');
        return textResult(sliceLines(content, offset, limit));
      } catch {
        fail(-32602, `File not found: ${relative}`);
      }
    },

    // ── doc_edit ────────────────────────────────────────────────────
    doc_edit: async (args) => {
      const namespace = args.namespace as string | undefined;
      const relative = args.path as string | undefined;
      const oldString = args.oldString as string | undefined;
      const newString = args.newString as string | undefined;
      if (!namespace || !relative || oldString === undefined || newString === undefined) {
        fail(-32602, 'Missing required params: namespace, path, oldString, newString');
      }
      if (oldString === newString) {
        fail(-32602, 'oldString and newString must differ');
      }
      const replaceAll = Boolean(args.replaceAll);
      const resolved = await resolveDocPath(namespace, relative);
      let content: string;
      try {
        content = await fs.readFile(resolved, 'utf-8');
      } catch {
        fail(-32602, `File not found: ${relative}`);
      }
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        fail(-32602, 'oldString not found in file');
      }
      if (occurrences > 1 && !replaceAll) {
        fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`);
      }
      const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
      await fs.writeFile(resolved, next, 'utf-8');
      await docsGitAdd(namespace, relative);
      return textResult(`Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${namespace}/${relative}.`);
    },

    // ── doc_write ───────────────────────────────────────────────────
    doc_write: async (args) => {
      const namespace = args.namespace as string | undefined;
      const relative = args.path as string | undefined;
      const content = args.content as string | undefined;
      if (!namespace || !relative || content === undefined) {
        fail(-32602, 'Missing required params: namespace, path, content');
      }
      const resolved = await resolveDocPath(namespace, relative);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, 'utf-8');
      await docsGitAdd(namespace, relative);
      return textResult(`Wrote ${content.length} bytes to ${namespace}/${relative}.`);
    },

    // ── doc_reply ───────────────────────────────────────────────────
    doc_reply: async (args) => {
      const namespace = args.namespace as string | undefined;
      const docPath = args.docPath as string | undefined;
      const commentId = args.commentId as string | undefined;
      const message = args.message as string | undefined;
      if (!namespace || !docPath || !commentId || !message) {
        fail(-32602, 'Missing required params: namespace, docPath, commentId, message');
      }
      const author = (args.author as string | undefined) ?? 'agent';
      await resolveDocPath(namespace, docPath);
      const existing = await readComments(namespace, docPath);
      const reply = createComment(author, message);
      await appendComment(namespace, docPath, reply, commentId);
      toastStore.broadcast({ type: 'doc_comments_updated', docPath });
      return textResult(JSON.stringify({ replyId: reply.id, parentId: commentId, threads: existing.length }, null, 2));
    },

    // ── doc_publish ─────────────────────────────────────────────────
    doc_publish: async (args) => {
      const namespace = args.namespace as string | undefined;
      const filePath = args.path as string | undefined;
      const message = args.message as string | undefined;
      if (!namespace || !filePath || !message) {
        fail(-32602, 'Missing required params: namespace, path, message');
      }
      const nodeId = await findDocNodeIdForNamespace(namespace);
      if (!nodeId) {
        fail(-32602, `No Documentation node found for namespace "${namespace}".`);
      }
      const mod = await getExtensionModule('builtin/core');
      const publishFn = mod.actions?.['docs.publish'];
      if (!publishFn) {
        fail(-32602, 'docs.publish action not found in builtin/core extension.');
      }
      const result = await publishFn({ nodeId, filePath, message });
      return textResult(JSON.stringify({ nodeId, namespace, path: filePath, ...result as object }, null, 2));
    },

    // ── read (remote) ────────────────────────────────────────────────
    remote_read: async (args) => {
      const filePath = args.path as string | undefined;
      if (!filePath) {
        fail(-32602, 'Missing required param: path');
      }
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const { ctx } = await resolveTerminalContext(args);
      const content = await remoteExec(ctx, `cat ${shellQuote(filePath)}`);
      const sliced = sliceLines(content, offset, limit);
      return textResult(catN(sliced, offset ?? 1));
    },

    // ── write (remote) ───────────────────────────────────────────────
    remote_write: withApprovalRequired(async (args) => {
      const filePath = args.path as string | undefined;
      const content = args.content as string | undefined;
      if (!filePath || content === undefined) {
        fail(-32602, 'Missing required params: path, content');
      }
      const { ctx } = await resolveTerminalContext(args);
      const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
      const heredoc = `cat > ${shellQuote(filePath)} << 'OPENCROFTEOF'\n${trimmed}\nOPENCROFTEOF`;
      await remoteExec(ctx, heredoc);
      return textResult(`The file ${filePath} has been written.`);
    }, { view: 'remote_write' }),

    // ── edit (remote) ────────────────────────────────────────────────
    remote_edit: withApprovalRequired(async (args) => {
      const filePath = args.path as string | undefined;
      const oldString = args.oldString as string | undefined;
      const newString = args.newString as string | undefined;
      if (!filePath || oldString === undefined || newString === undefined) {
        fail(-32602, 'Missing required params: path, oldString, newString');
      }
      if (oldString === newString) {
        fail(-32602, 'oldString and newString must differ');
      }
      const replaceAll = Boolean(args.replaceAll);
      const { ctx } = await resolveTerminalContext(args);

      const content = await remoteExec(ctx, `cat ${shellQuote(filePath)}`);
      const occurrences = content.split(oldString).length - 1;
      if (occurrences === 0) {
        fail(-32602, 'oldString not found in file');
      }
      if (occurrences > 1 && !replaceAll) {
        fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`);
      }

      const updated = replaceAll
        ? content.split(oldString).join(newString)
        : content.replace(oldString, newString);

      const trimmed = updated.endsWith('\n') ? updated.slice(0, -1) : updated;
      const heredoc = `cat > ${shellQuote(filePath)} << 'OPENCROFTEOF'\n${trimmed}\nOPENCROFTEOF`;
      await remoteExec(ctx, heredoc);
      return textResult(`The file ${filePath} has been updated successfully.`);
    }, { view: 'remote_edit' }),

    // ── exec (remote) ────────────────────────────────────────────────
    remote_exec: withApprovalRequired(async (args) => {
      const command = args.command as string | undefined;
      if (!command) {
        fail(-32602, 'Missing required param: command');
      }
      const { ctx } = await resolveTerminalContext(args);
      const prefix = await resolveSecretsForExec(args.secrets as string[] | undefined);
      const output = await remoteExec(ctx, prefix + command);
      return textResult(output);
    }, { view: 'remote_exec' }),

    // ── list_actions ─────────────────────────────────────────────────
    list_actions: async (args) => {
      const nodeId = args.nodeId as string | undefined;
      if (!nodeId) {
        fail(-32602, 'Missing required param: nodeId');
      }
      const actions = await listNodeActions(nodeId);
      return textResult(JSON.stringify(actions, null, 2));
    },

    // ── call ─────────────────────────────────────────────────────────
    call: withApprovalRequired(async (args) => {
      const nodeId = args.nodeId as string | undefined;
      const action = args.action as string | undefined;
      if (!nodeId || !action) {
        fail(-32602, 'Missing required params: nodeId, action');
      }
      const params = (args.params as Record<string, unknown> | undefined) ?? {};
      const result = await dispatchNodeAction(nodeId, action, params);
      const text = result === undefined ? `Action ${action} completed.` : JSON.stringify(result, null, 2);
      return textResult(text);
    }, { view: 'call' }),
  };
}

const handlers = buildHandlers();

function rejectionResult(reason: string): Record<string, unknown> {
  const text = reason
    ? `The tool use was rejected. The user provided the following reason for the rejection: ${reason}`
    : 'The tool use was rejected by the user.';
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  const handler = handlers[name];
  if (!handler) {
    // Fall back to graph-defined agent tools
    const execResult = await executeAgentTool(name, args, signal);
    await recordAudit({
      tool: name,
      args,
      result: execResult.result as Record<string, unknown>,
      status: execResult.requiredApproval ? 'approved' : 'auto-approved',
      durationMs: Date.now() - start,
    });
    return execResult.result as Record<string, unknown>;
  }
  const meta = getApprovalMeta(handler);
  const yolo = isYoloMode();
  try {
    if (meta && !yolo) {
      const spaceId = typeof args.space === 'string' ? await resolveSpace(args) : undefined;
      await awaitApproval({ tool: name, args, view: meta.view, signal, spaceId });
    }
    const result = await handler(args);
    await recordAudit({
      tool: name,
      args,
      result,
      status: yolo && meta ? 'auto-approved' : (meta ? 'approved' : 'auto-approved'),
      durationMs: Date.now() - start,
    });
    return result;
  } catch (e) {
    if (e instanceof ApprovalRejectedError) {
      await recordAudit({
        tool: name,
        args,
        error: e.reason || '(no reason)',
        status: 'rejected',
        durationMs: Date.now() - start,
      });
      return rejectionResult(e.reason);
    }
    const err = e as { message?: string };
    await recordAudit({
      tool: name,
      args,
      error: err.message ?? String(e),
      status: 'error',
      durationMs: Date.now() - start,
    });
    throw e;
  }
}
