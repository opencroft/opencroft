// What a node type's data validator reports (`NodeDataValidator` in
// `@opencroft/server/graph`), checked, compared and told the way graph writes
// refuse with it. Host-free, so tests load it directly.

import type { NodeDataProblem } from '@opencroft/core'

import { nodeErrorOf } from '@/app/_authed/(extension-runtime)/_node-errors'

/**
 * What a validator returned, as problems: each entry with a title and a
 * field path, its other fields kept only when they hold text. Anything else
 * is dropped, because it is stored on the node and read by agents.
 */
export function dataProblemsOf(value: unknown): NodeDataProblem[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    const error = nodeErrorOf(entry)
    return error?.path ? [{ ...error, path: error.path }] : []
  })
}

/** A node's data and the problems its type's validator finds in it. */
export interface CheckedData {
  data: Record<string, unknown>
  problems: readonly NodeDataProblem[]
}

/** The value at a dot path in `data`, as JSON; a path that is not there reads as undefined. */
function valueAt(data: unknown, path: string): string | undefined {
  let cur = data
  for (const segment of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, segment)) {
      return undefined
    }
    cur = (cur as Record<string, unknown>)[segment]
  }
  return JSON.stringify(cur)
}

/**
 * The problems of `after` that `before` did not have. A problem is one the
 * node had when `before` has one with its path and title and the value at
 * that path is unchanged. Its detail is not compared, because a detail may
 * read other fields, and a write to those does not make the problem new.
 * Writing one invalid value over another is refused.
 */
export function introducedProblems(before: CheckedData, after: CheckedData): NodeDataProblem[] {
  const held = (problem: NodeDataProblem) =>
    valueAt(before.data, problem.path) === valueAt(after.data, problem.path) &&
    before.problems.some((had) => had.path === problem.path && had.title === problem.title)
  return after.problems.filter((problem) => !held(problem))
}

/** A problem a write would introduce, with the node it is on. */
export interface RefusedProblem extends NodeDataProblem {
  nodeId: string
}

function problemLine({ nodeId, path, title, detail, next }: RefusedProblem): string {
  return [`${nodeId} ${path}: ${title}.`, detail, next].filter(Boolean).join(' ')
}

/** The refusal of a write that would introduce `problems`, one line each. */
export function dataRefusalText(problems: readonly RefusedProblem[]): string {
  return ['Refused: the write would store invalid node data. Nothing was written.', ...problems.map(problemLine)].join(
    '\n',
  )
}

/**
 * What a graph write throws to refuse `problems`: a tool refusal (invalid
 * params), so a surface that reads only its message tells all of it, carrying
 * the problems for a surface that answers them as they are.
 */
export interface DataRefusal {
  code: number
  message: string
  kind: typeof DATA_REFUSAL
  problems: RefusedProblem[]
}

const DATA_REFUSAL = 'invalid-node-data'

export function dataRefusal(problems: RefusedProblem[]): DataRefusal {
  return { code: -32602, message: dataRefusalText(problems), kind: DATA_REFUSAL, problems }
}

/** The problems `err` carries, when it is a `DataRefusal`. */
export function refusedProblemsOf(err: unknown): RefusedProblem[] | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined
  }
  const { kind, problems } = err as Partial<DataRefusal>
  return kind === DATA_REFUSAL ? problems : undefined
}
