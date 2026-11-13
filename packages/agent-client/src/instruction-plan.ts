// What to do with a harness's instruction files, decided from what they hold
// now. No I/O: instruction-files.ts reads the files, calls this, and carries
// out the answer, the same way on the host and in a container.
//
// A file the engine writes holds the text and nothing else, since all of it
// reaches the harness's context. What makes it the engine's is a sidecar
// beside it, `<file>.meta`, holding one line for a person who finds it.
// Deleting the sidecar hands the file back: from then on it is never written
// over or removed.

import type { InstructionRereads, InstructionTarget } from './harness-adapters'
import type { InstructionRole } from './instruction-paths'

/** One file as it was found: its resolved path, its content and its sidecar's, each null when there is none. */
export interface FoundFile {
  path: string
  content: string | null
  sidecar: string | null
}

/** The files a target names, read before anything is written. */
export interface FoundFiles {
  home?: FoundFile
  workspace?: FoundFile
  // The workspace fallback's file (InstructionTarget.workspace.localName).
  local?: FoundFile
  // Workspace files of other harnesses' targets: a file the engine wrote for
  // a harness other than the agent's current one is removed, since the
  // current one may read it too.
  others: FoundFile[]
  // Whether the working directory is inside a git repository, where a file
  // found in it belongs to the repository and is never adopted.
  inGitRepo: boolean
}

export type FileAction = { kind: 'write'; path: string; content: string } | { kind: 'remove'; path: string }

export interface InstructionPlan {
  // In the order they are carried out. A sidecar is written before its file
  // and removed after it, so a write cut short leaves a file the engine
  // still owns, never one it would take for somebody else's.
  actions: FileAction[]
  // Texts taken from files the engine did not own, to be stored as the role's text.
  adopted: { role: InstructionRole; text: string; path: string }[]
  // Texts that could not be placed: the file they go to exists, and the engine does not own it.
  refused: { role: InstructionRole; path: string }[]
  // Where each text is once the actions are carried out.
  placed: { role: InstructionRole; path: string; rereads: InstructionRereads }[]
  // The texts the files are written from, adopted ones included.
  texts: Record<InstructionRole, string>
}

// The heading of the agent text when it shares the home file with the shared text.
export const AGENT_SECTION_HEADING = '## Agent instructions'

/** The sidecar that marks the file at `path` as the engine's. */
export function sidecarPath(path: string): string {
  return `${path}.meta`
}

/** A sidecar's content: the host's wording, kept to one line. */
export function sidecarContent(wording: string): string {
  return `${wording.replace(/\s+/g, ' ').trim()}\n`
}

/** An instruction file's content: the text, ending in a newline. */
export function fileContent(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Decide every write and removal for one session open.
 *
 * - A file without a sidecar is never written over or removed. When the
 *   place has no shared text yet, such a shared home file is adopted as it;
 *   when the agent has no text, such a workspace file outside a git
 *   repository is adopted as the agent's. An adopted file gets its sidecar.
 * - A file with a sidecar is the engine's: it is replaced with the current
 *   text, whatever it holds now, and removed with its sidecar when its text
 *   is empty.
 * - A workspace file the engine does not own sends the agent text to the
 *   target's fallback.
 */
export function planInstructionFiles(
  target: InstructionTarget,
  texts: Partial<Record<InstructionRole, string>>,
  found: FoundFiles,
  wording: string,
): InstructionPlan {
  const plan: InstructionPlan = {
    actions: [],
    adopted: [],
    refused: [],
    placed: [],
    texts: { shared: texts.shared ?? '', agent: texts.agent ?? '' },
  }
  const { home, workspace, local } = found
  const adoptedPaths = new Set<string>()
  const adopt = (role: InstructionRole, file: FoundFile & { content: string }) => {
    plan.texts[role] = file.content
    plan.adopted.push({ role, text: file.content, path: file.path })
    adoptedPaths.add(file.path)
  }
  if (target.home?.shared && !plan.texts.shared && home && isForeign(home)) {
    adopt('shared', home)
  }
  if (target.workspace && !plan.texts.agent && workspace && isForeign(workspace) && !found.inGitRepo) {
    adopt('agent', workspace)
  }
  const ours = (file: FoundFile) => !isForeign(file) || adoptedPaths.has(file.path)
  const fallback = workspace && !ours(workspace) ? target.workspace?.fallback : undefined
  const { shared, agent } = plan.texts
  const section = fallback === 'home-section' && agent ? `${AGENT_SECTION_HEADING}\n\n${agent}` : ''
  const files: [FoundFile | undefined, string, InstructionRole[], InstructionRereads | undefined][] = [
    [home, [shared, section].filter(Boolean).join('\n\n'), section ? ['shared', 'agent'] : ['shared'], target.home?.rereads],
    [workspace, fallback ? '' : agent, ['agent'], target.workspace?.rereads],
    [local, fallback === 'local-file' ? agent : '', ['agent'], target.workspace?.rereads],
    ...found.others.map((file): [FoundFile, string, InstructionRole[], undefined] => [file, '', [], undefined]),
  ]
  const sidecar = sidecarContent(wording)
  for (const [file, text, roles, rereads] of files) {
    if (!file) {
      continue
    }
    if (!text) {
      if (file.sidecar !== null) {
        if (file.content !== null) {
          plan.actions.push({ kind: 'remove', path: file.path })
        }
        plan.actions.push({ kind: 'remove', path: sidecarPath(file.path) })
      }
      continue
    }
    const placedRoles = roles.filter((role) => plan.texts[role])
    if (!ours(file)) {
      plan.refused.push(...placedRoles.map((role) => ({ role, path: file.path })))
      continue
    }
    if (file.sidecar !== sidecar) {
      plan.actions.push({ kind: 'write', path: sidecarPath(file.path), content: sidecar })
    }
    const content = fileContent(text)
    if (file.content !== content) {
      plan.actions.push({ kind: 'write', path: file.path, content })
    }
    plan.placed.push(...placedRoles.map((role) => ({ role, path: file.path, rereads: rereads ?? 'session' })))
  }
  // A fallback the target names a file for, but no file was read for it.
  if (fallback && agent && !plan.placed.some((entry) => entry.role === 'agent')) {
    if (!plan.refused.some((entry) => entry.role === 'agent') && workspace) {
      plan.refused.push({ role: 'agent', path: workspace.path })
    }
  }
  return plan
}

// A file that is there and has no sidecar: somebody else's.
function isForeign(file: FoundFile): file is FoundFile & { content: string } {
  return file.content !== null && file.sidecar === null
}
