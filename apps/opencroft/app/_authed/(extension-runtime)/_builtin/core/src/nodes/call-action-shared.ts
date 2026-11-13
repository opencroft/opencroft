// The Call Action node. Run from `exec-in`, it calls one action of other
// nodes or of an app, with the action's parameters as its value inputs, then
// continues on Done (`exec-out`) or Failed (`exec-error`). What it calls is
// its data: `target`, `action`, and `params`, a snapshot of the action's
// parameters taken when the action was picked. Its handles follow that data
// (`callActionHandles`, for `declaredHandlesOf`), so the canvas, connectNodes,
// the resolvers and the agents' reads agree on them.
//
// The call's outcome is a run-time value: while Done or Failed dispatches, its
// outputs Result, Result text and Error carry what the action answered or why
// it failed (`callActionOutputValue`), and nothing outside that run.
//
// Pure: no runtime imports.

import type { NodeError } from '@opencroft/core'
import {
  BOOLEAN_TYPE,
  isObjectValue,
  NUMBER_TYPE,
  OBJECT_TYPE,
  PRIMITIVE_TYPES,
  STRING_TYPE,
  type ValueOption,
} from '@opencroft/core/values'
import type { GraphCallTarget } from '@opencroft/server/terminal'

import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { EXECUTION_TYPE } from './value-nodes-shared'

/** The Call Action's bare type, and its type as graphs store it. */
export const CALL_ACTION = 'call-action'
export const CALL_ACTION_TYPE = `builtin.core.${CALL_ACTION}`

/** The prefix of the input of each of the action's parameters: `param-<name>`. */
export const PARAM_PREFIX = 'param-'

/**
 * What a Call Action calls, `data.target`: one or more nodes of its space,
 * all of one type, called in order; or one App instance, by its instance id.
 */
export type CallActionTarget = GraphCallTarget

/** One of the action's parameters, as the Call Action keeps it: the input `param-<name>`. */
export interface CallActionParam {
  name: string
  /** The value type of its input, qualified: a text, a number or a boolean. */
  type: string
  required?: boolean
  /** A number parameter that takes whole numbers. */
  integer?: boolean
  /** A text parameter's choices, from its schema's `enum`. */
  options?: ValueOption[]
  description?: string
}

type Data = Readonly<Record<string, unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** What a Call Action that names no target, or no action, reports and fails with. */
export const NO_TARGET_PROBLEM: NodeError = {
  title: 'No target',
  next: 'Pick the nodes or the app to call on the card.',
}
export const NO_ACTION_PROBLEM: NodeError = { title: 'No action', next: 'Pick the action to call on the card.' }

/** What a call fails with when a required parameter has no value: nothing wired, nothing typed. */
export function missingParamProblem(name: string): NodeError {
  return {
    title: `${name} has no value`,
    detail: `The action requires "${name}", and nothing is typed or wired into it.`,
    next: `Type a value for ${name} on the card, or wire one into it.`,
  }
}

export function isCallAction(type: unknown): boolean {
  return type === CALL_ACTION_TYPE
}

/** The node's target, or undefined while it names none. */
export function callActionTargetOf(data: Data | undefined): CallActionTarget | undefined {
  const target = data?.target
  if (!isRecord(target)) {
    return undefined
  }
  if (Array.isArray(target.nodes)) {
    const nodes = target.nodes.filter((id): id is string => typeof id === 'string' && id !== '')
    return nodes.length > 0 ? { nodes } : undefined
  }
  return typeof target.app === 'string' && target.app.trim() !== '' ? { app: target.app } : undefined
}

/** The id of the action the node calls, or undefined while it names none. */
export function callActionIdOf(data: Data | undefined): string | undefined {
  const action = data?.action
  return typeof action === 'string' && action !== '' ? action : undefined
}

function paramOf(value: unknown): CallActionParam | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') {
    return undefined
  }
  if (typeof value.type !== 'string' || !PRIMITIVE_TYPES.includes(value.type)) {
    return undefined
  }
  const options = Array.isArray(value.options)
    ? value.options.filter((o): o is ValueOption => isRecord(o) && typeof o.value === 'string')
    : []
  return {
    name: value.name,
    type: value.type,
    ...(value.required === true ? { required: true } : {}),
    ...(value.integer === true ? { integer: true } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(typeof value.description === 'string' && value.description !== '' ? { description: value.description } : {}),
  }
}

/** The node's snapshot of the action's parameters, `data.params`, in order; entries that are not one are skipped. */
export function callActionParamsOf(data: Data | undefined): CallActionParam[] {
  const params = data?.params
  if (!Array.isArray(params)) {
    return []
  }
  return params.map(paramOf).filter((p): p is CallActionParam => p !== undefined)
}

export function paramHandleId(name: string): string {
  return `${PARAM_PREFIX}${name}`
}

/** The handles of a Call Action with `data`, in the order the card draws them: inputs first. */
export function callActionHandles(data: Data | undefined): ExtensionHandle[] {
  return [
    { id: 'exec-in', handleType: EXECUTION_TYPE, role: 'target', label: 'Run', multiple: true },
    ...callActionParamsOf(data).map(
      (param): ExtensionHandle => ({
        id: paramHandleId(param.name),
        handleType: param.type,
        role: 'target',
        label: param.name,
        ...(param.integer ? { integer: true } : {}),
        ...(param.options ? { options: param.options } : {}),
      }),
    ),
    { id: 'exec-out', handleType: EXECUTION_TYPE, role: 'source', label: 'Done' },
    { id: 'exec-error', handleType: EXECUTION_TYPE, role: 'source', label: 'Failed' },
    ...CALL_ACTION_OUTCOME_OUTPUTS,
  ]
}

/**
 * What a Call Action hands its run while Done or Failed dispatches: the
 * action's result, or the message of the failure. Its outcome outputs answer
 * from it (`callActionOutputValue`).
 */
export type CallActionOutcome = { result: unknown } | { error: string }

/** The outputs that carry the call's outcome, each with a value only while Done or Failed dispatches. */
export const CALL_ACTION_OUTCOME_OUTPUTS: readonly ExtensionHandle[] = [
  { id: 'result', handleType: OBJECT_TYPE, role: 'source', label: 'Result', runtime: true },
  { id: 'result-text', handleType: STRING_TYPE, role: 'source', label: 'Result text', runtime: true },
  { id: 'error', handleType: STRING_TYPE, role: 'source', label: 'Error', runtime: true },
]

/**
 * What the outcome output `handleId` carries in the run whose outcome is
 * `run`, or undefined: outside a run, and for an outcome it does not carry.
 * Result is an action's result that is an object, and Result text one that is
 * a text; a result of any other shape (a list, as several targets answer, a
 * number, nothing) is on neither. Error is set only after a failure.
 */
export function callActionOutputValue(handleId: string, run: unknown): unknown {
  if (!isRecord(run)) {
    return undefined
  }
  const own = (key: string) => (Object.hasOwn(run, key) ? run[key] : undefined)
  switch (handleId) {
    case 'result': {
      const result = own('result')
      return isObjectValue(result) ? result : undefined
    }
    case 'result-text': {
      const result = own('result')
      return typeof result === 'string' ? result : undefined
    }
    case 'error': {
      const error = own('error')
      return typeof error === 'string' ? error : undefined
    }
    default:
      return undefined
  }
}

/** What a parameter's schema says it takes, for a refusal: its `type`, else "a value of no single type". */
function schemaTypeText(property: unknown): string {
  const type = isRecord(property) ? property.type : undefined
  if (typeof type === 'string') {
    return type === 'array' ? 'a list' : `a value of type ${type}`
  }
  return 'a value of no single type'
}

/** The input a parameter's schema becomes, or undefined when no value input carries it. */
function paramOfProperty(name: string, property: unknown, required: boolean): CallActionParam | undefined {
  if (!isRecord(property)) {
    return undefined
  }
  const fields = {
    ...(required ? { required: true } : {}),
    ...(typeof property.description === 'string' && property.description !== ''
      ? { description: property.description }
      : {}),
  }
  switch (property.type) {
    case 'string': {
      const choices = Array.isArray(property.enum)
        ? property.enum.filter((v): v is string => typeof v === 'string')
        : []
      return {
        name,
        type: STRING_TYPE,
        ...(choices.length > 0 ? { options: choices.map((value) => ({ value })) } : {}),
        ...fields,
      }
    }
    case 'number':
      return { name, type: NUMBER_TYPE, ...fields }
    case 'integer':
      return { name, type: NUMBER_TYPE, integer: true, ...fields }
    case 'boolean':
      return { name, type: BOOLEAN_TYPE, ...fields }
    default:
      return undefined
  }
}

export type SchemaParams = { ok: true; params: CallActionParam[] } | { ok: false; unavailable: string }

/**
 * The parameters an action's input schema gives a Call Action: one per
 * top-level property that is a text, a number or a boolean, in the schema's
 * order. Any other property is not offered, and a required one makes the
 * action unavailable from a graph, which `unavailable` says.
 */
export function paramsOfSchema(schema: unknown): SchemaParams {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    isRecord(schema) && Array.isArray(schema.required)
      ? schema.required.filter((n): n is string => typeof n === 'string')
      : [],
  )
  const params: CallActionParam[] = []
  for (const [name, property] of Object.entries(properties)) {
    const param = paramOfProperty(name, property, required.has(name))
    if (param) {
      params.push(param)
    } else if (required.has(name)) {
      return {
        ok: false,
        unavailable: `Its required parameter "${name}" takes ${schemaTypeText(property)}, which a graph cannot pass.`,
      }
    }
  }
  return { ok: true, params }
}

/** Whether two parameter snapshots are the same, entry by entry. */
export function sameParams(a: readonly CallActionParam[], b: readonly CallActionParam[]): boolean {
  return JSON.stringify(a.map(paramOf)) === JSON.stringify(b.map(paramOf))
}
