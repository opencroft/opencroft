// Writes a harness's instruction files where the harness runs: with the file
// system for a host spawn, through `docker exec` for a container spawn, which
// reaches a container behind a remote Docker context the same way the spawn
// itself does, and through the selection's shell for a shell spawn. What to
// write is decided by instruction-plan.ts from what the files hold, read
// first; the same decision serves every place.

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'

import { errorMessage } from './errors'
import { HARNESS_ADAPTERS, type InstructionTarget } from './harness-adapters'
import { expandVariables, type InstructionRole, variableNames } from './instruction-paths'
import {
  type FileAction,
  type FoundFile,
  type FoundFiles,
  type InstructionPlan,
  planInstructionFiles,
  sidecarPath,
} from './instruction-plan'
import { placedShell, type ShellRunner } from './harness-process'
import { buildSpawnConfig, findAdapter, harnessPlacement, spawnEnvironment } from './resolve'
import type { AgentSelection, ShellResolver } from './types'

/** What a host's `loadInstructionFiles` answers for a selection. */
export interface InstructionTexts {
  // The text of the place the harness runs in, written as its home-level file.
  shared?: string
  // The agent's own text, written as the file in its working directory.
  agent?: string
  // The system prompt of a harness that takes its instructions that way
  // (InstructionTarget channel 'system-prompt'). Read before every prompt.
  systemPrompt?: string
  // Called once per text the engine adopted from a file it found without a
  // sidecar, for the host to store as that role's text. The file gets its
  // sidecar in the same open. A host stores it only while its own text is
  // still empty: another open may have stored one meanwhile.
  onAdopt?: (role: InstructionRole, text: string, path: string) => void | Promise<void>
}

/** One session open's writing, as the engine keeps it for the session. */
export interface InstructionSync {
  // A digest per text, to tell at the next prompt whether one changed.
  digests: Record<InstructionRole, string>
  placed: InstructionPlan['placed']
  // One sentence per text that could not be written, for the session's chat.
  problems: string[]
}

// The line of a sidecar (see instruction-plan.ts) and the change note, when the host gives none.
export const DEFAULT_INSTRUCTION_SIDECAR =
  'This file is written by the agent client at every session start. Edits to it are replaced. Delete this .meta file to stop the agent client writing it.'

export function defaultInstructionChangeNote(paths: string[]): string {
  return paths.map((path) => `Your instruction file \`${path}\` changed. Read it again before continuing.`).join('\n')
}

export function instructionDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Read and write access to the files of the place a harness runs in. */
export interface InstructionFileAccess {
  read(paths: FilePaths): Promise<FoundFiles>
  apply(actions: FileAction[]): Promise<void>
}

// The files to read, in the syntax of the place's own shell: `home` may hold
// variables, the rest are names in the working directory.
export interface FilePaths {
  home?: string
  workspace?: string
  local?: string
  others: string[]
}

/**
 * Write the selection's instruction files from `texts` and say how that went.
 * Undefined for a harness that has no files. Never throws: a file that could
 * not be read or written is one of the answer's `problems`, and the session
 * opens without it.
 */
export async function writeInstructionFiles(
  selection: AgentSelection,
  texts: InstructionTexts,
  wording: string,
  access: InstructionFileAccess = fileAccessFor(selection),
): Promise<InstructionSync | undefined> {
  const target = findAdapter(selection.adapterId)?.instructions
  if (target?.channel !== 'files') {
    return undefined
  }
  const requested = { shared: texts.shared ?? '', agent: texts.agent ?? '' }
  let plan: InstructionPlan
  try {
    const paths = filePaths(target, selection)
    plan = planInstructionFiles(target, requested, await access.read(paths), wording)
    await access.apply(plan.actions)
  } catch (error) {
    return {
      digests: digestsOf(requested),
      placed: [],
      problems: [
        `The instruction files could not be written: ${errorMessage(error)}. The session started without them.`,
      ],
    }
  }
  const problems = plan.refused.map(
    ({ path }) =>
      `The instruction file \`${path}\` could not be written: a file this client does not own is there (it has no \`${basename(sidecarPath(path))}\` beside it). The session started without its text.`,
  )
  for (const { role, text, path } of plan.adopted) {
    try {
      await texts.onAdopt?.(role, text, path)
    } catch (error) {
      problems.push(`The text found in \`${path}\` could not be kept: ${errorMessage(error)}.`)
    }
  }
  return { digests: digestsOf(plan.texts), placed: plan.placed, problems }
}

function digestsOf(texts: Record<InstructionRole, string>): Record<InstructionRole, string> {
  return { shared: instructionDigest(texts.shared), agent: instructionDigest(texts.agent) }
}

// Workspace names other harnesses' targets write, which this one does not.
function otherWorkspaceNames(target: InstructionTarget): string[] {
  const own = new Set([target.workspace?.name, target.workspace?.localName])
  const names = new Set<string>()
  for (const adapter of HARNESS_ADAPTERS) {
    for (const name of [adapter.instructions?.workspace?.name, adapter.instructions?.workspace?.localName]) {
      if (name && !own.has(name)) {
        names.add(name)
      }
    }
  }
  return [...names]
}

function filePaths(target: InstructionTarget, selection: AgentSelection): FilePaths {
  const home = target.home
  const onHost = harnessPlacement(selection).kind === 'host'
  return {
    home: home && (home.hostPath && onHost ? home.hostPath : home.path),
    workspace: target.workspace?.name,
    local: target.workspace?.fallback === 'local-file' ? target.workspace.localName : undefined,
    others: otherWorkspaceNames(target),
  }
}

/** Where the selection's harness runs: the host's file system, its container, or behind its shell. */
export function fileAccessFor(selection: AgentSelection, shells?: ShellResolver): InstructionFileAccess {
  const config = buildSpawnConfig(selection)
  const placement = harnessPlacement(selection)
  if (placement.kind === 'host') {
    return hostFileAccess(selection.cwd, spawnEnvironment(process.env, config))
  }
  return placedFileAccess(selection.cwd, config.env, placedShell(placement, shells))
}

/** The host's file system, with `env` as the harness's environment and `cwd` as its working directory. */
export function hostFileAccess(cwd: string, env: Record<string, string | undefined>): InstructionFileAccess {
  const locate = (path: string) =>
    resolvePath(
      cwd,
      expandVariables(
        path,
        (name) => env[name],
        (name) => {
          throw new Error(`${name} is not set`)
        },
      ),
    )
  const found = async (path: string): Promise<FoundFile> => {
    const absolute = locate(path)
    return { path: absolute, content: await readIfThere(absolute), sidecar: await readIfThere(sidecarPath(absolute)) }
  }
  return {
    async read(paths) {
      return {
        home: paths.home === undefined ? undefined : await found(paths.home),
        workspace: paths.workspace === undefined ? undefined : await found(paths.workspace),
        local: paths.local === undefined ? undefined : await found(paths.local),
        others: await Promise.all(paths.others.map(found)),
        inGitRepo: await insideGitRepo(resolvePath(cwd)),
      }
    },
    async apply(actions) {
      for (const action of actions) {
        if (action.kind === 'remove') {
          await rm(action.path, { force: true })
          continue
        }
        // Written beside the file and renamed over it, so a harness starting
        // meanwhile reads the old file or the new one, never half of one.
        await mkdir(dirname(action.path), { recursive: true })
        const temporary = `${action.path}.${randomUUID()}.tmp`
        await writeFile(temporary, action.content, 'utf8')
        await rename(temporary, action.path)
      }
    },
  }
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function insideGitRepo(directory: string): Promise<boolean> {
  for (let current = directory; ; current = dirname(current)) {
    if (await stat(resolvePath(current, '.git')).then(
      () => true,
      () => false,
    )) {
      return true
    }
    if (dirname(current) === current) {
      return false
    }
  }
}

export type { ShellRunner }

/**
 * A container's file system, through `docker exec` as the container's own
 * user, the one its harness runs as (placedFileAccess).
 */
export function containerFileAccess(
  container: string,
  cwd: string,
  env: Record<string, string>,
  run: ShellRunner = placedShell({ kind: 'container', container }, undefined),
): InstructionFileAccess {
  return placedFileAccess(cwd, env, run)
}

/**
 * The file system of a place the harness runs in apart from this process (a
 * container, a machine behind a shell), through `run` there. One call reads
 * every file and one call carries out the plan. Paths with variables are
 * resolved by that place's shell, with `env` (the spawn's environment)
 * forwarded by name for the ones the spawn sets.
 */
export function placedFileAccess(cwd: string, env: Record<string, string>, run: ShellRunner): InstructionFileAccess {
  return {
    async read(paths) {
      const templates = [paths.home, paths.workspace, paths.local, ...paths.others]
      for (const template of templates) {
        // Placed in the script between double quotes, so only the variable
        // syntax may reach the shell. The templates come from the adapter
        // table, never from a person.
        if (template !== undefined && !/^[\w${}:./-]+$/.test(template)) {
          throw new Error(`Not a path the engine can resolve where the harness runs: ${template}`)
        }
      }
      const named = new Set(templates.flatMap((template) => (template ? variableNames(template) : [])))
      const forwarded = Object.fromEntries(Object.entries(env).filter(([name]) => named.has(name)))
      const script = [
        `mkdir -p ${shellQuote(cwd)} && cd ${shellQuote(cwd)} || exit 3`,
        // Prints the resolved path, then for the file and for its sidecar F
        // and the content or M and an empty line, each line base64 so no
        // content can be read as a separator.
        'one() { if [ -f "$1" ]; then echo F; base64 < "$1" | tr -d "\\n"; echo; else echo M; echo; fi; }',
        `found() { case "$1" in /*) p="$1" ;; *) p="$PWD/$1" ;; esac; printf %s "$p" | base64 | tr -d "\\n"; echo; one "$p"; one "${sidecarPath('$p')}"; }`,
        'd="$PWD"; while :; do if [ -e "$d/.git" ]; then echo G; break; fi; if [ "$d" = / ]; then echo N; break; fi; d=$(dirname "$d"); done',
        ...templates.filter((template) => template !== undefined).map((template) => `found "${template}"`),
      ].join('\n')
      const lines = (await run(script, '', forwarded)).split('\n')
      let line = 1
      const at = (offset: number): string | null =>
        lines[line + offset] === 'F' ? decode(lines[line + offset + 1] ?? '') : null
      const next = (): FoundFile => {
        const found = { path: decode(lines[line] ?? ''), content: at(1), sidecar: at(3) }
        line += 5
        return found
      }
      return {
        inGitRepo: lines[0] === 'G',
        home: paths.home === undefined ? undefined : next(),
        workspace: paths.workspace === undefined ? undefined : next(),
        local: paths.local === undefined ? undefined : next(),
        others: paths.others.map(next),
      }
    },
    async apply(actions) {
      if (actions.length === 0) {
        return
      }
      const steps = actions.map((action) => {
        const path = shellQuote(action.path)
        if (action.kind === 'remove') {
          return `rm -f ${path}`
        }
        return `IFS= read -r c; t=${path}.$$.tmp; mkdir -p "$(dirname ${path})"; printf %s "$c" | base64 -d > "$t"; mv -f "$t" ${path}`
      })
      const stdin = actions
        .filter((action) => action.kind === 'write')
        .map((action) => `${Buffer.from(action.content, 'utf8').toString('base64')}\n`)
        .join('')
      await run(['set -e', ...steps].join('\n'), stdin, {})
    },
  }
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}
