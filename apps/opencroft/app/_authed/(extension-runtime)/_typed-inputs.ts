// The values typed into a node's primitive and enum inputs, `data.inputs.<handle id>`,
// checked against the handles the node declares. The host runs this beside
// each node type's own data validator, so a graph write that stores a value
// of the wrong type is refused naming the input, and the canvas shows one as
// the node's error.
//
// Safe for both server and client — no runtime imports beyond the host-free
// values module.

import type { NodeDataProblem } from '@opencroft/core'
import {
  BOOLEAN_TYPE,
  isEnumHandle,
  isPrimitiveType,
  isValueHandle,
  isValueType,
  NUMBER_TYPE,
  typedValueProblem,
} from '@opencroft/core/values'

import { type ExtensionHandle, findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

function takes(handle: ExtensionHandle): string {
  const { handleType } = handle
  if (handleType === NUMBER_TYPE) {
    return `a number (${handleType})`
  }
  if (handleType === BOOLEAN_TYPE) {
    return `true or false (${handleType})`
  }
  if (isEnumHandle(handle) && !isValueType(handleType)) {
    return `one of the cases of ${handleType}: ${(handle.cases ?? []).map((c) => c.value).join(', ')}`
  }
  return `text (${handleType})`
}

/**
 * What is wrong with the values typed into a node: `data.inputs` that is not
 * an object, or a value that its input does not take (see `typedValueProblem`;
 * the problem's path is `inputs.<handle id>`). A value for an input the node
 * does not declare, or one that is not primitive, is kept as it is, as an
 * edge to a handle that is gone is.
 */
export function typedInputProblems(
  handles: readonly ExtensionHandle[],
  data: Readonly<Record<string, unknown>>,
): NodeDataProblem[] {
  if (!Object.hasOwn(data, 'inputs')) {
    return []
  }
  const inputs = data.inputs
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return [
      {
        path: 'inputs',
        title: 'Must be an object',
        detail: "`inputs` holds the values typed into the node's inputs, by handle id.",
      },
    ]
  }
  const problems: NodeDataProblem[] = []
  for (const [id, value] of Object.entries(inputs)) {
    const handle = findExtensionHandle(handles, id, 'target')
    if (!handle || !isValueHandle(handle)) {
      continue
    }
    const name = handle.label ? `${handle.label} (${id})` : id
    if (handle.inline === false || !(isPrimitiveType(handle.handleType) || isEnumHandle(handle))) {
      problems.push({ path: `inputs.${id}`, title: 'Takes no typed value', detail: `The input ${name} must be wired.` })
      continue
    }
    const problem = typedValueProblem({ ...handle, id }, value)
    if (problem) {
      problems.push({
        path: `inputs.${id}`,
        title: problem.charAt(0).toUpperCase() + problem.slice(1),
        detail: `The input ${name} takes ${takes(handle)}.`,
      })
    }
  }
  return problems
}
