/**
 * The remote file and exec family, plus the whole remote-ops helper layer it is
 * built on: terminal-context resolution, atomic writes, counted reads and the
 * shared search rendering.
 */

import path from 'node:path'

import { withApprovalRequired } from '@/app/_authed/(approvals)/_server/with-approval'
import { isAppAddress, unresolvedAppTarget } from '@/app/_authed/(apps)/_server/app-address'
import { resolveAppHandleContext } from '@/app/_authed/(apps)/_server/runtime'
import { listLocalExtensionsImpl } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions-impl'
import { getExtensionModule, loadAllManifests } from '@/app/_authed/(extension-runtime)/_server/loader'
import { localExtRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import { startCommandTask, taskSummary, timeoutMsFrom } from '@/app/_authed/(mcp)/_server/task-tools'
import type { ToolCallerContext, ToolHandler } from '@/app/_authed/(mcp)/_server/tool-caller'
import {
  claimSlugForWrite,
  fail,
  type GraphNode,
  isValidLocalExtensionSlug,
  LOCAL_EXTENSION_HANDLE_NODE_ID,
  type ParsedEndpoint,
  parseEndpoint,
  replaceExact,
  textResult,
} from '@/app/_authed/(mcp)/_server/tool-shared'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { secrets } from '@/server/secrets'

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

export const definitions = [
  {
    name: 'remote_read',
    description:
      'Read a file from a remote node. The target is a terminal-context output handle, "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>" (e.g. "localhost_abc/terminal"). Output is line-numbered (cat -n style). Optional offset/limit slice by 1-indexed line. A file too large for one read comes back cut, with an unnumbered "(truncated …)" note as the last line — when you see it, the file continues past what you were shown, so do not conclude anything from where it appears to end.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
      'Find file paths by glob on a remote node\'s filesystem (`**` spans directories, `*` doesn\'t, `?` = one char), e.g. "src/**/*.tsx". The target is a terminal-context output handle, "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>". Read-only. Returns one matching path per line, relative to `path`. Dependency/VCS/build directories (node_modules, .git, dist, …) are skipped unless `includeIgnored` is set or `path` points inside one. No matches (or a missing `path`) return "(no matches)" rather than an error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
      'Search file contents by regular expression (POSIX extended, i.e. `grep -E`) on a remote node\'s filesystem, recursively under `path`. The target is a terminal-context output handle, "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>". Read-only. Returns matching lines as "path:line:text", one per line, with paths echoed in the same form `path` was given (relative when omitted). Dependency/VCS/build directories (node_modules, .git, dist, …) are skipped unless `includeIgnored` is set or `path` points inside one; overlong lines are column-truncated. No matches (or a missing `path`) return "(no matches)" rather than an error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
      'Write or overwrite a file on a remote node. The target is a terminal-context output handle, "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
    // Awaitable, like remote_script: a build, a test suite or an image pull
    // outlasts the ~2 minutes a call can wait, so the caller may detach it.
    execution: 'awaitable' as const,
    description:
      'Execute a shell command on a remote node. The target is a terminal-context output handle, "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>". Optionally inject secret values from any Secrets Store as env vars (reference them in the command via "$NAME"). Very large output is cut, with a "(truncated …)" note as the last line — treat the result as incomplete rather than as the command\'s full output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
    execution: 'awaitable' as const,
    description:
      'Execute a multiline bash script on a remote node. Unlike remote_exec, the script body is written to a temp file first, so it avoids quoting/escaping issues with heredocs, loops, and nested quotes. The target is a terminal-context output handle, "<node-id>/<handle-id>" or an App instance\'s "<space>.<app-slug>/<handle-id>". Optionally inject secret values from any Secrets Store as env vars (reference them in the script via "$NAME"). Very large output is cut, with a "(truncated …)" note as the last line — treat the result as incomplete rather than as the script\'s full output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: {
          type: 'string',
          description:
            'Terminal-context output handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — see app_list for addresses.',
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
]

const CORE_EXTENSION_ID = 'builtin/core'

async function findNodeAcrossSpaces(nodeId: string): Promise<{ node: GraphNode; slug: string }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  // Whichever graph of whichever space holds the node; the SPACE slug is the
  // answer, matching what the terminal-context resolution scopes by.
  const ref = registry.findByNode(nodeId)
  const node = ref?.graph.graph.nodes.find((n) => (n as { id?: string }).id === nodeId) as GraphNode | undefined
  if (!ref || !node) {
    fail(-32602, `Node not found: ${nodeId}`)
  }
  return { node, slug: ref.space.slug }
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

/**
 * The local extension a terminal target addresses, or null when it addresses an
 * ordinary graph node.
 *
 * Pure string work on the caller's own `target` argument, so a guard can decide
 * whether it applies before any lookup, filesystem access or approval happens.
 */
export function extensionSlugFromTarget(target: unknown): string | null {
  if (typeof target !== 'string' || target.length === 0) {
    return null
  }
  const ep = parseEndpoint(target)
  if (ep.nodeId !== LOCAL_EXTENSION_HANDLE_NODE_ID || !ep.handle) {
    return null
  }
  return isValidLocalExtensionSlug(ep.handle) ? ep.handle : null
}

async function claimForWrite(args: Record<string, unknown>, caller: ToolCallerContext): Promise<void> {
  const slug = extensionSlugFromTarget(args.target)
  if (slug) {
    await claimSlugForWrite(slug, caller)
  }
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
    fail(
      -32602,
      'target must include a handle: "<node-id>/<handle-id>", or an App instance\'s "<space>.<app-slug>/<handle-id>" — run app_list for addresses',
    )
  }

  const localExtCtx = await resolveLocalExtensionContext(ep)
  if (localExtCtx) {
    return { ctx: localExtCtx, slug: ep.handle }
  }

  // An App instance's handle uses the same "<left>/<handle>" syntax with the
  // app's ADDRESS (`<space>.<app-slug>`) or its uuid in the node position.
  // Checked before graph resolution — a miss costs one index read.
  const appHandle = await resolveAppHandleContext(ep.nodeId, ep.handle)
  if (appHandle) {
    return { ctx: appHandle.value, slug: appHandle.spaceSlug }
  }
  // A DOTTED left side is an app address and can be nothing else, because node
  // ids never contain a dot. Falling through to the graph lookup would answer
  // "no such node" about an app — pointing the reader at the wrong half of the
  // target, and at the wrong kind of thing entirely.
  if (isAppAddress(ep.nodeId)) {
    fail(-32602, await unresolvedAppTarget(ep.nodeId, ep.handle))
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

/** Resolve one of the core extension's actions, failing loudly when it is not there. */
async function coreAction(name: string): Promise<(...args: unknown[]) => unknown> {
  const core = await getExtensionModule(CORE_EXTENSION_ID)
  const action = core.actions[name]
  if (!action) {
    fail(-32603, `Core extension has no ${name} action`)
  }
  return action as (...args: unknown[]) => unknown
}

/**
 * Run a command and report whether the backend cut its stdout at the output cap.
 *
 * Worth carrying: the cap truncates rather than erroring, so a tool that hands command output to
 * a reader cannot otherwise tell a complete result from a clipped one — and neither can the
 * reader. Any tool whose output a caller will reason over should use this and say so.
 *
 * Deliberately NOT what `remoteExec` is built on, even though it could be. The extension module
 * cache lives on `globalThis`, so it outlives a hot reload: a deploy that pulls new code without
 * restarting the process keeps serving the previously loaded core extension, and an action added
 * in the same commit is missing until a restart. Keeping the plain path on the older action means
 * that window costs the three tools that report truncation, not every remote tool there is.
 */
export async function remoteExecDetailed(
  ctx: Record<string, unknown>,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<{ stdout: string; truncated: boolean }> {
  const execFn = await coreAction('terminal.execDetailed')
  return execFn(ctx, command, opts) as Promise<{ stdout: string; truncated: boolean }>
}

/**
 * Run a command and return its stdout, discarding whether that stdout was complete.
 *
 * Correct only when nobody downstream reads the output — a `mv`, a `chmod`, a byte count the
 * caller parses itself. **If the result reaches a human or a model, use `remoteExecDetailed` and
 * report the truncation**, because a string that was cut is indistinguishable from a command
 * that produced exactly that much, and a reader will treat it as the whole answer.
 *
 * The discard is deliberately spelled out here rather than left to the shorter name: this is the
 * easier function to reach for, its bare `string` return makes dropping the flag type-clean, and
 * that omission is the original defect in a friendlier form.
 */
export async function remoteExec(
  ctx: Record<string, unknown>,
  command: string,
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  const execFn = await coreAction('terminal.exec')
  return execFn(ctx, command, opts) as Promise<string>
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
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

/**
 * The one truncation note every tool appends, so a reader learns the same shape once and
 * recognises it everywhere. `remedy` is the whole tail, not a fragment slotted into a fixed
 * sentence: the tools do not all have the same way out, and a shared "… to see the rest" ending
 * would have forced the ones that cannot honestly say it to say it anyway.
 *
 * The leading `…` and the parentheses are what keep it from reading as content. That matters
 * most for `remote_read`, whose body is `cat -n`-style numbered lines that get pasted and
 * grepped: an unnumbered parenthetical cannot be mistaken for a line of the file, whereas a bare
 * sentence could be. Appending on its own line is part of the convention, not a detail.
 */
export function withTruncationNote(body: string, truncated: boolean, remedy: string): string {
  return truncated ? `${body}\n… (truncated — ${remedy})` : body
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
  return textResult(withTruncationNote(body, truncated, 'narrow the pattern, path, or glob to see the rest'))
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
 *
 * The first chunk truncating is why callers must aim this at a scratch path and never at the
 * file they mean to replace: the destination is empty from the first command until the last one
 * lands, so a failure in between leaves only what arrived. `buildTempWritePath` and
 * `buildAtomicReplaceCommand` are the other half of that contract.
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

/** What the remote reports about a write target before anything has been written to it. */
export interface RemoteWriteTarget {
  /** The path the content must land at, with a final symlink component already resolved. */
  path: string
  /** Octal mode to give the scratch file, or null when the target does not exist yet. */
  mode: string | null
}

/**
 * Build the probe that runs before a write: whether the target is a symlink, what it resolves
 * to, whether it exists, and its mode — everything needed to place the scratch file correctly
 * and to hand the replacement the permissions the target already had.
 *
 * Every field is emitted unconditionally, empty ones included, and a trailing `ok=1` marks a
 * complete run. That is what lets `parseResolveTarget` tell "this remote has no working
 * `stat -c`" apart from "this file does not exist": if a failed substitution were simply left
 * out the two would be indistinguishable, and guessing wrong means silently resetting a file's
 * mode. `readlink -f` and `stat -c` are both GNU, so a BusyBox or BSD remote must be detected
 * rather than quietly degraded to.
 *
 * That detection only bites where something could be destroyed. Creating a file that does not
 * exist yet has no symlink to resolve and no mode to carry, so it needs neither utility and
 * still succeeds; the refusal falls on writes to an *existing* target, whose mode or symlink
 * would otherwise be discarded without a word.
 */
export function buildResolveTargetCommand(filePath: string): string {
  return [
    `t=${shellQuote(filePath)}`,
    `if [ -L "$t" ]; then l=1; else l=0; fi`,
    `if [ -e "$t" ]; then e=1; else e=0; fi`,
    `r=$(readlink -f "$t" 2>/dev/null || true)`,
    `m=$(stat -c %a "$t" 2>/dev/null || true)`,
    `printf 'link=%s\\nresolved=%s\\nexists=%s\\nmode=%s\\nok=1\\n' "$l" "$r" "$e" "$m"`,
  ].join('; ')
}

/**
 * Read a `buildResolveTargetCommand` response, refusing the write when the remote could not
 * answer rather than proceeding on a guess. Each refusal below is a case where carrying on would
 * quietly destroy something: an unresolvable symlink gets replaced by a regular file, and an
 * unreadable mode gets reset to the umask default.
 */
export function parseResolveTarget(output: string, filePath: string): RemoteWriteTarget {
  const fields = new Map<string, string>()
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) {
      fields.set(line.slice(0, separator), line.slice(separator + 1))
    }
  }
  if (fields.get('ok') !== '1') {
    fail(-32603, `Cannot write ${filePath}: the remote did not complete the pre-write probe.`)
  }
  const resolved = fields.get('resolved') ?? ''
  if (fields.get('link') === '1' && !resolved) {
    fail(
      -32603,
      `Cannot write ${filePath}: it is a symlink and this remote has no working \`readlink -f\` to resolve it.`,
    )
  }
  const target = resolved || filePath
  if (fields.get('exists') !== '1') {
    return { path: target, mode: null }
  }
  const mode = fields.get('mode') ?? ''
  if (!/^[0-7]{3,4}$/.test(mode)) {
    fail(
      -32603,
      `Cannot write ${filePath}: this remote reported no usable file mode (\`stat -c %a\` gave ${JSON.stringify(mode)}), ` +
        'so the existing permissions could not be preserved.',
    )
  }
  return { path: target, mode }
}

/**
 * Scratch path for an atomic write. `resolvedPath` must be the target with its final symlink
 * component already resolved: the scratch has to share a directory with the file the rename
 * actually lands on, not with the name the caller happened to use. A symlink pointing into
 * another filesystem would otherwise put the two on different mounts, where `mv` degrades to
 * open-truncate-copy-unlink — the very failure this exists to prevent, moved to a rarer path.
 *
 * A symlinked *parent* component is harmless: the redirect that creates the scratch follows it
 * too, so both land in the same real directory. It is only the final component that matters.
 *
 * `/tmp` is wrong for the same reason — routinely a different mount. Dot-prefixed and
 * `.tmp`-suffixed so a leftover is recognisable and stays out of ordinary globs. `token` is
 * supplied by the caller so this stays pure and unit-testable.
 */
export function buildTempWritePath(resolvedPath: string, token: string): string {
  const dir = path.posix.dirname(resolvedPath)
  const base = path.posix.basename(resolvedPath)
  return path.posix.join(dir, `.${base}.${token}.tmp`)
}

/**
 * Create the scratch file empty and give it the target's mode BEFORE any content lands in it.
 * The order is about confidentiality, not tidiness: applying the mode afterwards would leave a
 * 0600 file's contents sitting at the umask default for the whole duration of the write. `>` on
 * an existing file truncates without touching its permissions, so the chunks that follow inherit
 * the mode set here.
 *
 * `&&`, not `;`: if the mode cannot be applied the write stops here, while the scratch file is
 * still empty and the target untouched. A chmod that fails and gets renamed over the target
 * anyway produces exactly the silent 0755 → 0644 downgrade this step exists to prevent.
 */
export function buildScratchInitCommand(tmpPath: string, mode: string | null): string {
  const tmp = shellQuote(tmpPath)
  return mode === null ? `: > ${tmp}` : `: > ${tmp} && chmod ${shellQuote(mode)} ${tmp}`
}

/**
 * Rename the finished scratch file over the target. Both paths sit in the same resolved
 * directory, so this is a single `rename(2)`: a reader sees either the whole old file or the
 * whole new one, and any failure before this point leaves the original exactly as it was.
 *
 * Two properties of the old in-place redirect are deliberately NOT preserved, because replacing
 * a directory entry cannot preserve them:
 *
 * - **Ownership.** The scratch file belongs to whoever ran the write, and no `chown` is
 *   attempted: it needs privileges the writer may not have, so making it mandatory would turn
 *   writes that work today into failures. A write by someone other than the file's owner
 *   therefore changes its owner.
 * - **Hard links.** The old redirect wrote through the inode, so every link saw the new content.
 *   A rename swaps the directory entry instead, so other links keep the old content and the link
 *   count drops. Accepted deliberately: writing through a shared inode silently mutates every
 *   other path pointing at it — files hard-linked out of a package cache, for one — and the
 *   in-place write that preserved links is the same one that truncated the target on failure.
 *
 * Also worth naming: this needs the containing directory writable, where writing in place needed
 * only the file to be. A write into a read-only directory now fails loudly.
 */
export function buildAtomicReplaceCommand(tmpPath: string, targetPath: string): string {
  return `mv -f ${shellQuote(tmpPath)} ${shellQuote(targetPath)}`
}

/**
 * The orchestration behind every remote write, with the exec channel injected so the ordering
 * can be tested without a shell: probe the target, prepare a scratch file beside its *resolved*
 * path, assemble the content there, verify the byte count THERE, and only then rename it into
 * place.
 *
 * The order is the whole point. Assembling in place meant the target was truncated by the first
 * chunk and rebuilt by the rest, so a failure on any later chunk left a short file behind — and
 * the `wc -c` check that would have caught it never ran, because the loop had already thrown.
 * The guard was bypassed in exactly the case it existed for. Assembling elsewhere means every
 * way this can fail now fails with the original still intact.
 *
 * The scratch file is removed on the way out of a failure. That covers a failed run; a process
 * killed mid-write can still strand one, which is why the name is recognisable.
 *
 * Resolving in its own round trip widens one window worth naming: the gap between resolving the
 * target and renaming onto it now spans the whole content write rather than a single shell
 * command. If the target is re-pointed inside that window, the write lands on the destination
 * that was resolved at probe time rather than the new one. It cannot separate the scratch file
 * from its destination — both are derived from the same resolved value — so the worst outcome is
 * a write to a stale destination, never a partial file.
 */
export async function writeFileExactWith(
  exec: (command: string) => Promise<string>,
  filePath: string,
  content: string,
  token: string = crypto.randomUUID(),
): Promise<void> {
  // Outside the try: a probe that fails has created no scratch file to clean up.
  const target = parseResolveTarget(await exec(buildResolveTargetCommand(filePath)), filePath)
  const tmpPath = buildTempWritePath(target.path, token)
  try {
    // The scratch preparation rides along with the first chunk rather than paying its own round
    // trip. Both halves stay independently testable; `&&` keeps the mode strictly before content.
    const [firstChunk, ...remainingChunks] = buildBase64WriteCommands(tmpPath, content)
    await exec(`${buildScratchInitCommand(tmpPath, target.mode)} && ${firstChunk}`)
    for (const command of remainingChunks) {
      await exec(command)
    }
    const expectedBytes = Buffer.byteLength(content, 'utf8')
    const wcOut = await exec(`wc -c < ${shellQuote(tmpPath)}`)
    const actualBytes = Number.parseInt(wcOut.trim(), 10)
    if (!Number.isFinite(actualBytes) || actualBytes !== expectedBytes) {
      const reported = Number.isFinite(actualBytes) ? String(actualBytes) : wcOut.trim() || '(empty)'
      fail(
        -32603,
        `Write verification failed for ${filePath}: expected ${expectedBytes} bytes, remote reports ${reported}.`,
      )
    }
    await exec(buildAtomicReplaceCommand(tmpPath, target.path))
  } catch (err) {
    try {
      await exec(`rm -f ${shellQuote(tmpPath)}`)
    } catch {
      /* best-effort; if the remote is unreachable there is nothing left to clean up */
    }
    throw err
  }
}

/** Write `content` to `filePath` on the remote exactly byte-for-byte, atomically. */
async function writeRemoteFileExact(
  ctx: Record<string, unknown>,
  filePath: string,
  content: string,
  opts?: { cwd?: string },
): Promise<void> {
  return writeFileExactWith((command) => remoteExec(ctx, command, opts), filePath, content)
}

/**
 * Read a file and its byte count in one round trip: the count on the first line, the content
 * after it. Pairs with `parseCountedRead`, which refuses the read when the two disagree.
 */
export function buildCountedReadCommand(filePath: string): string {
  const quotedPath = shellQuote(filePath)
  return `wc -c < ${quotedPath}; cat ${quotedPath}`
}

/**
 * Split a `buildCountedReadCommand` response into the declared byte count and the content that
 * followed it, and refuse the read when they disagree.
 *
 * Worth checking because the exec transport caps collected output and truncates rather than
 * erroring, and that cap is invisible to the caller: the result carries a `truncated` flag, but
 * the exec wrapper returns only the stdout string and drops it. An edit built on a short read is
 * silent data loss in its own right — the replacement matches inside the fragment, succeeds, and
 * writes the fragment back as the whole file.
 *
 * A file that is not valid UTF-8 also fails here, since the content is measured as UTF-8 bytes.
 * That is the honest answer rather than a convenient one: the write path re-encodes as UTF-8, so
 * such a file was already being mangled by any edit, and refusing is the smaller harm.
 */
export function parseCountedRead(output: string, filePath: string): string {
  const newline = output.indexOf('\n')
  const declared = newline === -1 ? Number.NaN : Number.parseInt(output.slice(0, newline), 10)
  if (!Number.isFinite(declared)) {
    fail(-32603, `Read verification failed for ${filePath}: the remote reported no byte count.`)
  }
  const content = output.slice(newline + 1)
  const actualBytes = Buffer.byteLength(content, 'utf8')
  if (actualBytes !== declared) {
    fail(
      -32603,
      `Read verification failed for ${filePath}: expected ${declared} bytes, received ${actualBytes}. ` +
        'Refusing to edit a partial read.',
    )
  }
  return content
}

// Resolves each name to a plain env map and lets the terminal backend (packages/terminal) inject
// it out of band -- never build the command string ourselves. A value spliced into a shell
// string, however it's encoded, ends up in that process's argv for its whole lifetime, readable
// by `ps`/`pgrep` to anyone else on the same host; a value handed to the backend as `env` never
// touches argv at all (see buildEnvInjection in packages/terminal/src/server/exec-util.ts).
export async function resolveSecretsEnv(names: string[] | undefined): Promise<Record<string, string> | undefined> {
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

/**
 * Render a remote_read response: slice to the requested range, number the lines, and say so when
 * the file arrived cut.
 *
 * The note is attached to the READ, not to the slice — it appears whenever the file was cut,
 * even when the requested range sits well inside what did arrive. The read has no way to know
 * how much further the file went, so any line count or "it ends here" taken from it is unsound
 * regardless of which part was asked for.
 *
 * The remedy deliberately does not offer `offset`/`limit`. The whole file is fetched with `cat`
 * and sliced here, against the string that already arrived, so no offset reaches past the cap —
 * telling a reader to narrow the range would be a confident wrong instruction on the one surface
 * that exists to stop producing them. Reaching later parts needs the slicing to happen on the
 * remote instead.
 */
export function renderReadResult(content: string, truncated: boolean, offset?: number, limit?: number): string {
  const body = catN(sliceLines(content, offset, limit), offset ?? 1)
  return withTruncationNote(
    body,
    truncated,
    'the file is larger than one read can return; offset/limit only index what already arrived, ' +
      'so fetch later parts by slicing on the remote (e.g. sed -n) instead',
  )
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

export const handlers: Record<string, ToolHandler> = {
  // ── read (remote) ────────────────────────────────────────────────
  //
  // remote_read, remote_glob and remote_grep below.
  //
  // ALL THREE ARE AUTO-ALLOWED (see READ_ONLY_TOOLS), so a call reaches the
  // remote shell without anyone being asked. What that rests on is a
  // conjunction, not a guarantee the runtime enforces:
  //
  //   - no verb in the composed command writes -- `cat`, `find`, `grep`; and
  //   - every value interpolated into it is quoted.
  //
  // Both hold in the three handlers below and neither is checked anywhere.
  // Adding an unquoted interpolation, or a verb that can write, silently
  // removes the property these tools were admitted on -- and, because they
  // no longer prompt, removes it without anybody seeing the call. Changing
  // how any of them builds its argv means revisiting READ_ONLY_TOOLS in the
  // same change.
  remote_read: async (args) => {
    const filePath = args.path as string | undefined
    if (!filePath) {
      fail(-32602, 'Missing required param: path')
    }
    const offset = args.offset as number | undefined
    const limit = args.limit as number | undefined
    const { ctx } = await resolveTerminalContext(args)
    const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)
    const { stdout: content, truncated } = await remoteExecDetailed(ctx, `cat ${shellQuote(resolvedPath)}`)
    return textResult(renderReadResult(content, truncated, offset, limit))
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
    async (args, caller) => {
      const filePath = args.path as string | undefined
      const content = args.content as string | undefined
      if (!filePath || content === undefined) {
        fail(-32602, 'Missing required params: path, content')
      }
      await claimForWrite(args, caller)
      const { ctx } = await resolveTerminalContext(args)
      const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)
      await writeRemoteFileExact(ctx, resolvedPath, content)
      return textResult(`The file ${resolvedPath} has been written.`)
    },
    { view: 'remote_write' },
  ),

  // ── edit (remote) ────────────────────────────────────────────────
  remote_edit: withApprovalRequired(
    async (args, caller) => {
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
      await claimForWrite(args, caller)
      const { ctx } = await resolveTerminalContext(args)
      const resolvedPath = resolveRemoteFilePath(filePath, ctx.cwd as string | undefined)

      const content = parseCountedRead(await remoteExec(ctx, buildCountedReadCommand(resolvedPath)), resolvedPath)
      const updated = replaceExact(content, { oldString, newString, replaceAll }, 'file')

      await writeRemoteFileExact(ctx, resolvedPath, updated)
      return textResult(`The file ${resolvedPath} has been updated successfully.`)
    },
    { view: 'remote_edit' },
  ),

  // ── exec (remote) ────────────────────────────────────────────────
  remote_exec: withApprovalRequired(
    async (args, caller) => {
      const command = args.command as string | undefined
      if (!command) {
        fail(-32602, 'Missing required param: command')
      }
      const background = args.background === true
      // Read before the lease below is taken: a malformed timeout is a bad
      // argument, and fails as one before anything is claimed for the caller.
      const timeoutMs = background ? timeoutMsFrom(args.timeoutMinutes) : null
      const cwd = args.cwd as string | undefined
      // A command is opaque, so it counts as a write: there is no way to tell
      // an inspection from an edit without interpreting a shell.
      await claimForWrite(args, caller)
      const { ctx } = await resolveTerminalContext(args)
      const effectiveCwd = cwd
        ? resolveRemoteFilePath(cwd, ctx.cwd as string | undefined)
        : (ctx.cwd as string | undefined)
      if (background) {
        // Here, inside the approval wrapper and past the same checks as a call
        // run in place: a detached command is still one somebody approved.
        // Secrets go as names; the service puts their values in the process's
        // environment when it starts it.
        return startCommandTask(caller, {
          name: 'remote_exec',
          target: args.target as string,
          command,
          cwd: effectiveCwd,
          secrets: args.secrets as string[] | undefined,
          timeoutMs,
          summary: taskSummary(args.description, command),
        })
      }
      const env = await resolveSecretsEnv(args.secrets as string[] | undefined)
      const { stdout, truncated } = await remoteExecDetailed(ctx, command, { cwd: effectiveCwd, env })
      return textResult(withTruncationNote(stdout, truncated, "narrow the command's output to see the rest"))
    },
    { view: 'remote_exec' },
  ),

  // ── script (remote) ──────────────────────────────────────────────
  remote_script: withApprovalRequired(
    async (args, caller) => {
      const script = args.script as string | undefined
      if (!script) {
        fail(-32602, 'Missing required param: script')
      }
      const background = args.background === true
      const timeoutMs = background ? timeoutMsFrom(args.timeoutMinutes) : null
      const scriptArgs = (args.args as string[] | undefined) ?? []
      const cwd = args.cwd as string | undefined
      await claimForWrite(args, caller)
      const { ctx } = await resolveTerminalContext(args)
      const effectiveCwd = cwd
        ? resolveRemoteFilePath(cwd, ctx.cwd as string | undefined)
        : (ctx.cwd as string | undefined)
      if (background) {
        // The body and its positional arguments go separately, as the in-place
        // path passes them: the node runs `bash script.sh <args>`, so $1… and
        // bash's own line numbers are what a synchronous run would have seen.
        return startCommandTask(caller, {
          name: 'remote_script',
          target: args.target as string,
          command: script,
          ...(scriptArgs.length > 0 ? { args: scriptArgs } : {}),
          cwd: effectiveCwd,
          secrets: args.secrets as string[] | undefined,
          timeoutMs,
          summary: taskSummary(args.description, script),
        })
      }
      const env = await resolveSecretsEnv(args.secrets as string[] | undefined)
      const tmpPath = `/tmp/opencroft-script-${crypto.randomUUID()}.sh`
      try {
        await writeRemoteFileExact(ctx, tmpPath, script)
        const argv = scriptArgs.map(shellQuote).join(' ')
        // Same exposure as remote_exec — this is command output too, and a script is the more
        // likely of the two to produce enough of it to be cut.
        const { stdout, truncated } = await remoteExecDetailed(
          ctx,
          `bash ${shellQuote(tmpPath)} ${argv}; rc=$?; rm -f ${shellQuote(tmpPath)}; exit $rc`,
          { cwd: effectiveCwd, env },
        )
        return textResult(withTruncationNote(stdout, truncated, "narrow the script's output to see the rest"))
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
}
