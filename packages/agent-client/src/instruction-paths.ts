// Where a selection's harness reads its instruction texts, as paths a reader
// can be shown. Client-safe like resolve.ts: no node builtins, so an editor in
// the browser can label each text with the file it becomes.

import type { InstructionRereads } from './harness-adapters'
import { buildSpawnConfig, findAdapter, harnessPlacement } from './resolve'
import type { AgentSelection } from './types'

export type InstructionRole = 'shared' | 'agent'

export interface InstructionFilePath {
  role: InstructionRole
  path: string
  rereads: InstructionRereads
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * Expand `$NAME`, `${NAME}` and `${NAME:-default}` the way `sh` does: a
 * variable that is unset or empty takes its default, which is expanded in
 * turn. `unknown` answers for a variable with neither a value nor a default.
 */
export function expandVariables(
  template: string,
  lookup: (name: string) => string | undefined,
  unknown: (name: string) => string,
): string {
  return template.replace(VARIABLE, (_match, braced: string | undefined, fallback: string | undefined, bare: string) => {
    const name = braced ?? bare
    const value = lookup(name)
    if (value) {
      return value
    }
    return fallback === undefined ? unknown(name) : expandVariables(fallback, lookup, unknown)
  })
}

/** The variables a template names, those in defaults included. */
export function variableNames(template: string): string[] {
  return [...template.matchAll(VARIABLE)].flatMap(([, braced, fallback, bare]) => [
    braced ?? bare,
    ...(fallback ? variableNames(fallback) : []),
  ])
}

/** `relative` joined onto the directory `base`, POSIX-style, with `.` and `..` segments applied. */
export function joinPosix(base: string, relative: string): string {
  const parts: string[] = []
  for (const part of `${base}/${relative}`.split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part && part !== '.') {
      parts.push(part)
    }
  }
  return `${base.startsWith('/') ? '/' : ''}${parts.join('/')}`
}

/**
 * The files a selection's texts are written to, as configured: the home file
 * for the shared text and the workspace file for the agent text. Where a file
 * the engine did not write takes the workspace name, the agent text goes to
 * the harness's fallback instead (see InstructionTarget); that is found only
 * when the files are read, so it is not shown here. The home directory of a
 * container's user, which only its shell knows, reads as `~`.
 */
export function instructionFilePaths(selection: AgentSelection): InstructionFilePath[] {
  const target = findAdapter(selection.adapterId)?.instructions
  if (target?.channel !== 'files') {
    return []
  }
  const env = buildSpawnConfig(selection).env
  const paths: InstructionFilePath[] = []
  if (target.home) {
    const path =
      target.home.hostPath && harnessPlacement(selection).kind === 'host'
        ? joinPosix(selection.cwd, target.home.hostPath)
        : expandVariables(
            target.home.path,
            (name) => (name === 'HOME' ? '~' : env[name]),
            (name) => `$${name}`,
          )
    paths.push({ role: 'shared', path, rereads: target.home.rereads })
  }
  if (target.workspace) {
    paths.push({ role: 'agent', path: joinPosix(selection.cwd, target.workspace.name), rereads: target.workspace.rereads })
  }
  return paths
}
