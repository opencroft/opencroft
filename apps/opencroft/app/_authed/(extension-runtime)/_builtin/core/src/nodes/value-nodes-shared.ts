// The core value nodes: Value, Convert, Format, Math Expression, Text
// Compare, Select, Switch, Regex Search, Regex Replace and Get. Every one but
// Switch is pure: each output is computed from the node's inputs, read the
// way every value input is read (wired, else typed on the card, else the declared default; see
// `inputValue`). The server's `exposeOutput`, the canvas's and the card
// compute it with the same function here, `valueNodeOutput`, from the node's
// data, which carries its wired inputs (see `resolved-inputs.ts` in
// `@opencroft/core/values`).
//
// Their handles follow their data: Value's output and Convert's have the type
// set on the node (`data.valueType`), Math Expression's inputs are the
// variables of its expression, Format's the placeholders of its template, and
// Regex Search's outputs the capture groups of its pattern. Convert's input,
// Select's and Switch's inputs, and Math Expression's free variables, take
// several types, and have
// the type connected into them (`data.inputTypes`, see `inputTypeOf`):
// Select's Value has the type of its True and False, Switch's outputs follow
// the type of its condition (one per case of an enum, told by the host's
// `EnumCasesOf`), and Math Expression's result can follow its variables.
// `valueNodeHandles` derives them, for `declaredHandlesOf`, so the canvas,
// connectNodes, the resolvers and the agents' reads agree on them.
//
// Pure: no runtime imports.

import type { NodeDataProblem, NodeError } from '@opencroft/core'
import {
  awaitingRunOf,
  BOOLEAN_TYPE,
  type CompiledPattern,
  compilePattern,
  type EnumCasesOf,
  type ExpressionType,
  evaluateExpression,
  expressionTypes,
  formatTemplate,
  handleTakes,
  inputTypeOf,
  inputValue,
  isObjectValue,
  isPrimitiveValue,
  isValueType,
  MAX_PATTERN_LENGTH,
  NUMBER_TYPE,
  OBJECT_TYPE,
  type ParsedExpression,
  type PatternGroup,
  PRIMITIVE_TYPES,
  type PrimitiveValue,
  parseExpression,
  parsePath,
  parseTemplate,
  readPath,
  resolvedInputsOf,
  STRING_TYPE,
  SWITCH_CONDITION_TYPES,
  switchCaseOutput,
  switchCasesOf,
  switchConditionType,
  takesSeveralTypes,
  type Value,
  type ValueHandle,
  type ValueOption,
  wiredValueOf,
  withEnumCases,
} from '@opencroft/core/values'

import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { convertValue } from './value-conversion'

/** The extension that declares the value nodes. */
const CORE = 'builtin.core'

/** The execution type, qualified as graphs store it. */
export const EXECUTION_TYPE = `${CORE}.execution-context`

/** The value nodes, by their bare types. */
export const VALUE_NODE = {
  value: 'value',
  convert: 'convert',
  format: 'format',
  mathExpression: 'math-expression',
  textCompare: 'text-compare',
  select: 'select',
  switch: 'switch',
  regexSearch: 'regex-search',
  regexReplace: 'regex-replace',
  get: 'get',
} as const

export type ValueNodeType = (typeof VALUE_NODE)[keyof typeof VALUE_NODE]

const VALUE_NODE_TYPES: readonly string[] = Object.values(VALUE_NODE)

/** The bare type of a value node, from its type as graphs store it (qualified), or undefined for any other node. */
export function valueNodeTypeOf(type: unknown): ValueNodeType | undefined {
  if (typeof type !== 'string' || !type.startsWith(`${CORE}.`)) {
    return undefined
  }
  return bareValueNodeType(type.slice(CORE.length + 1))
}

/** `bare` as a value node's type, as core's own handlers are told it, or undefined for any other node. */
export function bareValueNodeType(bare: string): ValueNodeType | undefined {
  return VALUE_NODE_TYPES.includes(bare) ? (bare as ValueNodeType) : undefined
}

/** The qualified type of a value node. */
export function valueNodeQualifiedType(bare: ValueNodeType): string {
  return `${CORE}.${bare}`
}

/** Text Compare's operators, by the id stored in `data.op`, with the sentence the card shows for each. */
export const TEXT_COMPARE_OPERATORS = [
  { id: 'is', label: 'A is B' },
  { id: 'is-not', label: 'A is not B' },
  { id: 'contains', label: 'A contains B' },
  { id: 'starts-with', label: 'A starts with B' },
  { id: 'ends-with', label: 'A ends with B' },
] as const

export type TextCompareOperator = (typeof TEXT_COMPARE_OPERATORS)[number]['id']

/**
 * Whether text `a` is, is not, contains, starts with or ends with text `b`,
 * by Text Compare's operator `op` (`is` for any other). Both are compared in
 * Unicode NFC, and with `ignoreCase` lowercased by the locale-independent
 * `toLowerCase`, so the server and the canvas always agree (`Straße` does not
 * match `STRASSE`). An empty `b` is contained in, starts and ends every text.
 */
export function compareTexts(op: unknown, a: string, b: string, ignoreCase: boolean): boolean {
  const comparable = (text: string) => (ignoreCase ? text.normalize('NFC').toLowerCase() : text.normalize('NFC'))
  const x = comparable(a)
  const y = comparable(b)
  switch (op) {
    case 'is-not':
      return x !== y
    case 'contains':
      return x.includes(y)
    case 'starts-with':
      return x.startsWith(y)
    case 'ends-with':
      return x.endsWith(y)
    default:
      return x === y
  }
}

/** The value types Get reads. */
export const GET_TYPES: readonly string[] = [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE, OBJECT_TYPE]

/** The type Convert converts to before one is chosen. */
const CONVERT_DEFAULT_TYPE = NUMBER_TYPE

/**
 * The type a Value holds, `data.valueType`: text, a number, a boolean, or an
 * enum by its qualified type; text when none is set. An enum no loaded
 * extension declares keeps its type, as an edge keeps a handle that is gone.
 */
export function valueTypeOfValueNode(data: Data): string {
  const type = data.valueType
  return typeof type === 'string' && type !== '' && (PRIMITIVE_TYPES.includes(type) || !isValueType(type))
    ? type
    : STRING_TYPE
}

/** The type Convert converts to, `data.valueType`: text, a number or a boolean; a number when none is set. */
export function convertTypeOf(data: Data): string {
  const type = data.valueType
  return typeof type === 'string' && PRIMITIVE_TYPES.includes(type) ? type : CONVERT_DEFAULT_TYPE
}

// Convert's input as it is declared: it takes text, a number or a boolean,
// text before anything is connected.
const CONVERT_INPUT = { id: 'value', handleType: STRING_TYPE, accepts: [...PRIMITIVE_TYPES] }

/** What a Value of `type` holds while nothing is set: an empty text, 0, false, an enum's first case. */
export function defaultValueOf(type: string, enumCasesOf: EnumCasesOf): PrimitiveValue | undefined {
  switch (type) {
    case STRING_TYPE:
      return ''
    case NUMBER_TYPE:
      return 0
    case BOOLEAN_TYPE:
      return false
    default:
      return enumCasesOf(type)?.[0]?.value
  }
}

/** The types a Math Expression variable that `==`, `!=` or `? :` alone decides takes, the first the one it has before anything is connected. */
export const FREE_VARIABLE_TYPES: readonly string[] = [NUMBER_TYPE, BOOLEAN_TYPE]

/**
 * The types Select picks among, the first the one it has before anything is
 * connected into True or False. It picks among every enum as well.
 */
export const SELECT_TYPES: readonly string[] = [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE, OBJECT_TYPE]

/** The type group of Select's True and False, which share one type. */
export const SELECT_GROUP = 'value'

// Select's True and False as their type group declares them.
const SELECT_BRANCH = {
  handleType: SELECT_TYPES[0],
  accepts: [...SELECT_TYPES],
  acceptsEnums: true,
  typeGroup: SELECT_GROUP,
}

/** The name a value type is shown by. */
export function valueTypeLabel(type: string): string {
  switch (type) {
    case NUMBER_TYPE:
      return 'Number'
    case BOOLEAN_TYPE:
      return 'Boolean'
    case OBJECT_TYPE:
      return 'Object'
    default:
      return 'Text'
  }
}

/** What an output that has a value only while a run dispatches says while nothing runs. */
export const WHEN_IT_RUNS = 'When it runs'

/** The prefixes of the inputs Math Expression and Format make from their data. */
export const VARIABLE_PREFIX = 'var-'
export const PLACEHOLDER_PREFIX = 'arg-'

/** The prefix of the outputs Regex Search makes from the capture groups of its pattern. */
export const GROUP_PREFIX = 'group-'

type Data = Readonly<Record<string, unknown>>

function stringOf(data: Data, key: string, fallback = ''): string {
  const value = data[key]
  return typeof value === 'string' ? value : fallback
}

/** The pattern of a Regex Search or Regex Replace, compiled with its `ignoreCase` (see `compilePattern`). */
export function patternOf(data: Data): CompiledPattern {
  return compilePattern(stringOf(data, 'pattern'), data.ignoreCase === true)
}

/** Whether a Regex Replace replaces every match, `data.all`: absent is true. */
export function replacesAll(data: Data): boolean {
  return data.all !== false
}

function typeOf(data: Data, allowed: readonly string[]): string {
  const value = data.valueType
  return typeof value === 'string' && allowed.includes(value) ? value : allowed[0]
}

/** The type Select's True, False and Value have now: the type connected into True or False, text before any was. */
export function selectTypeOf(data: Data): string {
  return inputTypeOf(data, { id: 'true', ...SELECT_BRANCH })
}

function target(id: string, handleType: string, label: string, fields: Partial<ExtensionHandle> = {}): ExtensionHandle {
  return { id, handleType, role: 'target', label, ...fields }
}

function source(id: string, handleType: string, label: string): ExtensionHandle {
  return { id, handleType, role: 'source', label }
}

// An input of a type a value is typed into takes one; an object input is wired.
function typedOrWired(handleType: string): Partial<ExtensionHandle> {
  return handleType === OBJECT_TYPE ? { inline: false } : {}
}

const valueTypeOf = (type: ExpressionType) => (type === 'boolean' ? BOOLEAN_TYPE : NUMBER_TYPE)

// The inputs of a free group of a Math Expression's variables share the type
// group `var-<group>`, named by the group's first variable.
function freeVariable(group: string) {
  return {
    id: `${VARIABLE_PREFIX}${group}`,
    handleType: FREE_VARIABLE_TYPES[0],
    accepts: [...FREE_VARIABLE_TYPES],
    typeGroup: `${VARIABLE_PREFIX}${group}`,
  }
}

/** The type each free group of a Math Expression's variables has now: the type connected into it, a number before any was. */
function freeGroupTypes(expression: ParsedExpression, data: Data): Record<string, ExpressionType> {
  const free: Record<string, ExpressionType> = {}
  for (const [group, type] of Object.entries(expression.groupTypes)) {
    if (type === 'free') {
      free[group] = inputTypeOf(data, freeVariable(group)) === BOOLEAN_TYPE ? 'boolean' : 'number'
    }
  }
  return free
}

// A Math Expression's variable inputs, typed as the expression uses each, and
// its result. A boolean variable defaults to false, a number one to 0. A free
// variable takes a number or a boolean, in its group, and has the type
// connected into the group; a result that has a free group's type follows it.
function mathExpressionHandles(data: Data): ExtensionHandle[] {
  const parsed = parseExpression(stringOf(data, 'expression'))
  if (!parsed.ok) {
    return [source('result', NUMBER_TYPE, 'Result')]
  }
  const { expression } = parsed
  const types = expressionTypes(expression, freeGroupTypes(expression, data))
  const variables = expression.variables.map((name) => {
    const type = types.variables[name]
    const group = expression.groups[name]
    const free = expression.groupTypes[group] === 'free'
    return target(`${VARIABLE_PREFIX}${name}`, valueTypeOf(type), name, {
      default: type === 'boolean' ? false : 0,
      ...(free ? { accepts: freeVariable(group).accepts, typeGroup: freeVariable(group).typeGroup } : {}),
    })
  })
  return [...variables, source('result', valueTypeOf(types.result), 'Result')]
}

/** A Format's placeholder names, in order of first appearance. */
export function templateNames(data: Data): string[] {
  return parseTemplate(stringOf(data, 'template')).names
}

/**
 * The handles of a Switch, from the type its condition has now: True and
 * False for a boolean; for a text one output per case typed on it, by the
 * case's id; for an enum one output per case of the enum, by its value, in
 * the declared order (none while `enumCasesOf` does not know the enum); then
 * Default.
 */
function switchHandles(data: Data, enumCasesOf: EnumCasesOf): ExtensionHandle[] {
  const type = switchConditionType(data)
  const inputs = [
    target('exec-in', EXECUTION_TYPE, 'Run', { multiple: true }),
    target('condition', type, 'Condition', {
      accepts: [...SWITCH_CONDITION_TYPES],
      acceptsEnums: true,
      ...(type === BOOLEAN_TYPE ? { default: false } : {}),
    }),
  ]
  if (type === BOOLEAN_TYPE) {
    return [...inputs, source('exec-true', EXECUTION_TYPE, 'True'), source('exec-false', EXECUTION_TYPE, 'False')]
  }
  const cases =
    type === STRING_TYPE
      ? switchCasesOf(data).map((c) => source(switchCaseOutput(c.id), EXECUTION_TYPE, c.value))
      : (enumCasesOf(type) ?? []).map((c) => source(switchCaseOutput(c.value), EXECUTION_TYPE, c.label ?? c.value))
  return [...inputs, ...cases, source('exec-default', EXECUTION_TYPE, 'Default')]
}

// A Regex Search's output for a capture group: `group-<name>` for a named
// group, which keeps its edge when groups are added before it, and
// `group-<n>` for a numbered one, which moves with them.
function groupOutput(group: PatternGroup): ExtensionHandle {
  return group.name === undefined
    ? source(`${GROUP_PREFIX}${group.number}`, STRING_TYPE, `Group ${group.number}`)
    : source(`${GROUP_PREFIX}${group.name}`, STRING_TYPE, group.name)
}

/** The handles of a Regex Search: an output per capture group of its pattern, none while it does not compile. */
function regexSearchHandles(data: Data): ExtensionHandle[] {
  const compiled = patternOf(data)
  return [
    target('text', STRING_TYPE, 'Text', { default: '' }),
    source('matched', BOOLEAN_TYPE, 'Matched'),
    source('match', STRING_TYPE, 'Match'),
    ...(compiled.ok ? compiled.pattern.groups.map(groupOutput) : []),
  ]
}

/**
 * The handles a value node has with `data`, every id concrete, in the order
 * the card draws them: inputs first. `enumCasesOf` gives a Switch on an enum
 * its outputs.
 */
export function valueNodeHandles(type: ValueNodeType, data: Data, enumCasesOf: EnumCasesOf): ExtensionHandle[] {
  switch (type) {
    case VALUE_NODE.value:
      return [source('value', valueTypeOfValueNode(data), 'Value')]
    case VALUE_NODE.convert: {
      const to = convertTypeOf(data)
      return [
        target('value', inputTypeOf(data, CONVERT_INPUT), 'Value', { accepts: CONVERT_INPUT.accepts }),
        source('value', to, valueTypeLabel(to)),
      ]
    }
    case VALUE_NODE.format:
      return [
        ...templateNames(data).map((name) => target(`${PLACEHOLDER_PREFIX}${name}`, STRING_TYPE, name)),
        source('text', STRING_TYPE, 'Text'),
      ]
    case VALUE_NODE.mathExpression:
      return mathExpressionHandles(data)
    case VALUE_NODE.textCompare:
      return [
        target('a', STRING_TYPE, 'A', { default: '' }),
        target('b', STRING_TYPE, 'B', { default: '' }),
        source('result', BOOLEAN_TYPE, 'Result'),
      ]
    case VALUE_NODE.select: {
      const t = selectTypeOf(data)
      const { handleType: _first, ...branch } = SELECT_BRANCH
      return [
        target('condition', BOOLEAN_TYPE, 'Condition', { default: false }),
        target('true', t, 'True', { ...branch, ...typedOrWired(t) }),
        target('false', t, 'False', { ...branch, ...typedOrWired(t) }),
        source('value', t, 'Value'),
      ]
    }
    case VALUE_NODE.get: {
      const t = typeOf(data, GET_TYPES)
      return [
        target('object', OBJECT_TYPE, 'Object', { inline: false }),
        target('path', STRING_TYPE, 'Path', { default: '' }),
        target('fallback', t, 'Fallback', typedOrWired(t)),
        source('value', t, 'Value'),
      ]
    }
    case VALUE_NODE.switch:
      return switchHandles(data, enumCasesOf)
    case VALUE_NODE.regexSearch:
      return regexSearchHandles(data)
    case VALUE_NODE.regexReplace:
      return [
        target('text', STRING_TYPE, 'Text', { default: '' }),
        target('replacement', STRING_TYPE, 'Replacement', { default: '' }),
        source('text', STRING_TYPE, 'Text'),
        source('count', NUMBER_TYPE, 'Count'),
      ]
  }
}

/**
 * What an output computes to: its value, or why it has none. `awaitsRun`: it
 * has none because an input it needs has a value only while a run dispatches
 * (see `AWAITING_RUN_KEY`), so it is not an error of the node.
 */
export type OutputResult = { ok: true; value: Value } | { ok: false; error: string; awaitsRun?: true }

const fine = (value: Value): OutputResult => ({ ok: true, value })
const failed = (error: string): OutputResult => ({ ok: false, error })
const awaiting: OutputResult = { ok: false, error: WHEN_IT_RUNS, awaitsRun: true }

function valueHandle(handles: readonly ExtensionHandle[], id: string): ValueHandle | undefined {
  const handle = handles.find((h) => h.role === 'target' && h.id === id)
  return handle ? { ...handle, id } : undefined
}

/** The value input `id` of a node with `data` and `handles` reads (see `inputValue`). */
export function readInput(data: Data, handles: readonly ExtensionHandle[], id: string): Value | undefined {
  const handle = valueHandle(handles, id)
  return handle ? inputValue(data, handle, wiredValueOf(data, id)) : undefined
}

// A Format placeholder takes its value before it became text: a wired
// number keeps its digits for `{n:03}`, a wired date its epoch for a date
// format. A typed value is text, as the input takes it.
function placeholderValue(data: Data, read: (id: string) => Value | undefined, id: string): unknown {
  const wired = wiredValueOf(data, id)
  if (wired) {
    const raw = wired.value
    if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'string') {
      return raw
    }
  }
  return read(id)
}

/** What a value is, for an error that names it: `a text`, `a list`. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) {
    return 'a list'
  }
  if (value === null) {
    return 'null'
  }
  if (typeof value === 'string') {
    return 'a text'
  }
  if (typeof value === 'number') {
    return 'a number'
  }
  return typeof value === 'boolean' ? 'true or false' : 'an object'
}

/** What a value of each value type is, in the words `kindOf` uses. */
const TYPE_KINDS: Readonly<Record<string, string>> = {
  [STRING_TYPE]: 'a text',
  [NUMBER_TYPE]: 'a number',
  [BOOLEAN_TYPE]: 'true or false',
  [OBJECT_TYPE]: 'an object',
}

/** `value` when it is of `type` exactly, else undefined: Get converts nothing, so `"42"` read as a number is nothing. */
function ofType(type: string, value: unknown): Value | undefined {
  switch (type) {
    case NUMBER_TYPE:
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined
    case BOOLEAN_TYPE:
      return typeof value === 'boolean' ? value : undefined
    case OBJECT_TYPE:
      return isObjectValue(value) ? value : undefined
    default:
      return typeof value === 'string' ? value : undefined
  }
}

// A Get: the value at `path` in `object` when it is there and of the output's
// type; else, when the path is not there, the fallback. A value of another
// type is an error even with a fallback: a body whose age is "thirty" is not
// a missing age. While its object awaits a run it has nothing yet, whatever
// the fallback, as the card says.
function getOutput(
  data: Data,
  handles: readonly ExtensionHandle[],
  read: (id: string) => Value | undefined,
): OutputResult {
  const path = read('path')
  if (path === undefined) {
    return failed('Path has no value')
  }
  const parsed = parsePath(String(path))
  if (!parsed.ok) {
    return failed(parsed.error)
  }
  const object = read('object')
  if (object === undefined && awaitingRunOf(data).includes('object')) {
    return awaiting
  }
  const found = object === undefined ? undefined : readPath(object, parsed.segments)
  if (found?.found) {
    const type = handles.find((h) => h.role === 'source')?.handleType ?? STRING_TYPE
    const value = ofType(type, found.value)
    return value === undefined ? failed(`"${path}" is ${kindOf(found.value)}, not ${TYPE_KINDS[type]}`) : fine(value)
  }
  const fallback = read('fallback')
  if (fallback !== undefined) {
    return fine(fallback)
  }
  return failed(object === undefined ? 'Object has no value' : `"${path}" is not in the object`)
}

// A Value's output: the value set on it when it is of the Value's type, the
// type's default while none is set. Nothing is converted, so a value of
// another type, as an agent's write of the type alone leaves it, is the
// node's error until the value is set again.
function valueNodeValue(data: Data, out: ExtensionHandle): OutputResult {
  const type = out.handleType
  const cases = isValueType(type) ? undefined : out.cases
  if (!isValueType(type) && !cases) {
    return failed(`No loaded extension declares the type ${type}`)
  }
  const stored = data.value
  if (stored === undefined) {
    const value = defaultValueOf(type, () => cases)
    return value === undefined ? failed(`${type} has no cases`) : fine(value)
  }
  if (cases) {
    return typeof stored === 'string' && cases.some((c) => c.value === stored)
      ? fine(stored)
      : failed(`"${String(stored)}" is not one of: ${cases.map((c) => c.value).join(', ')}`)
  }
  const value = ofType(type, stored)
  return value === undefined ? failed(`The value is ${kindOf(stored)}, not ${TYPE_KINDS[type]}`) : fine(value)
}

/**
 * What output `handleId` of a value node of `type` with `data` computes to,
 * or undefined for a handle that is not one of its value outputs (Switch has
 * none). An input with no value is an error naming it, unless that input
 * awaits a run: then the output awaits it too (`awaitsRun`). An input of an
 * enum type (Select's True and False) reads through the cases `enumCasesOf`
 * gives: a typed value that is not one of them has no value.
 */
export function valueNodeOutput(
  type: ValueNodeType,
  handleId: string,
  data: Data,
  enumCasesOf: EnumCasesOf,
): OutputResult | undefined {
  const handles = withEnumCases(valueNodeHandles(type, data, enumCasesOf), enumCasesOf)
  const out = handles.find((h) => h.role === 'source' && h.id === handleId)
  if (!out || out.handleType === EXECUTION_TYPE) {
    return undefined
  }
  const empty = new Set<string>()
  const read = (id: string) => {
    const value = readInput(data, handles, id)
    if (value === undefined) {
      empty.add(id)
    }
    return value
  }
  const result = computeOutput(type, handleId, data, handles, read)
  const awaited = awaitingRunOf(data)
  return !result.ok && [...empty].some((id) => awaited.includes(id)) ? awaiting : result
}

function computeOutput(
  type: ValueNodeType,
  handleId: string,
  data: Data,
  handles: readonly ExtensionHandle[],
  read: (id: string) => Value | undefined,
): OutputResult {
  const labelOf = (id: string) => handles.find((h) => h.role === 'target' && h.id === id)?.label ?? id
  const missing = (id: string) => failed(`${labelOf(id)} has no value`)
  switch (type) {
    case VALUE_NODE.value:
      return valueNodeValue(data, handles.find((h) => h.role === 'source') as ExtensionHandle)
    case VALUE_NODE.convert: {
      const value = read('value')
      if (value === undefined) {
        return missing('value')
      }
      // Its input takes text, a number or a boolean, and reads nothing else.
      const converted = convertValue(value as PrimitiveValue, convertTypeOf(data))
      return converted.ok ? fine(converted.value) : failed(converted.error)
    }
    case VALUE_NODE.format: {
      const values: Record<string, unknown> = {}
      for (const name of templateNames(data)) {
        values[name] = placeholderValue(data, read, `${PLACEHOLDER_PREFIX}${name}`)
      }
      const result = formatTemplate(stringOf(data, 'template'), values)
      return result.ok ? fine(result.text) : failed(result.error)
    }
    case VALUE_NODE.mathExpression: {
      const parsed = parseExpression(stringOf(data, 'expression'))
      if (!parsed.ok) {
        return failed(parsed.error.message)
      }
      const variables: Record<string, number | boolean> = {}
      for (const name of parsed.expression.variables) {
        const value = read(`${VARIABLE_PREFIX}${name}`)
        if (typeof value === 'number' || typeof value === 'boolean') {
          variables[name] = value
        }
      }
      const result = evaluateExpression(parsed.expression, variables, freeGroupTypes(parsed.expression, data))
      return result.ok ? fine(result.value) : failed(result.error)
    }
    case VALUE_NODE.textCompare: {
      const a = read('a')
      const b = read('b')
      if (a === undefined) {
        return missing('a')
      }
      if (b === undefined) {
        return missing('b')
      }
      return fine(compareTexts(data.op, String(a), String(b), data.ignoreCase === true))
    }
    case VALUE_NODE.select: {
      const condition = read('condition')
      if (condition === undefined) {
        return missing('condition')
      }
      const picked = condition ? 'true' : 'false'
      const value = read(picked)
      return value === undefined ? missing(picked) : fine(value)
    }
    case VALUE_NODE.switch:
      return failed('A Switch routes execution and has no value outputs')
    case VALUE_NODE.get:
      return getOutput(data, handles, read)
    case VALUE_NODE.regexSearch: {
      const compiled = patternOf(data)
      if (!compiled.ok) {
        return failed(compiled.error)
      }
      const text = read('text')
      if (text === undefined) {
        return missing('text')
      }
      // The pattern keeps its last match, so the node's other outputs reuse this search.
      const match = compiled.pattern.search(String(text))
      if (handleId === 'matched') {
        return fine(match !== null)
      }
      if (handleId === 'match') {
        return fine(match?.text ?? '')
      }
      const group = compiled.pattern.groups.findIndex((g) => groupOutput(g).id === handleId)
      return fine(match?.groups[group] ?? '')
    }
    case VALUE_NODE.regexReplace: {
      const compiled = patternOf(data)
      if (!compiled.ok) {
        return failed(compiled.error)
      }
      const text = read('text')
      const replacement = read('replacement')
      if (text === undefined) {
        return missing('text')
      }
      if (replacement === undefined) {
        return missing('replacement')
      }
      const result = compiled.pattern.replace(String(text), String(replacement), replacesAll(data))
      if (!result.ok) {
        return failed(result.error)
      }
      return fine(handleId === 'count' ? result.count : result.text)
    }
  }
}

/** The value outputs of a value node with `data`, each with what it computes to (see `valueNodeOutput`). */
export function valueNodeOutputs(
  type: ValueNodeType,
  data: Data,
  enumCasesOf: EnumCasesOf,
): Array<{ handle: ExtensionHandle; result: OutputResult }> {
  return valueNodeHandles(type, data, enumCasesOf)
    .filter((h) => h.role === 'source' && h.handleType !== EXECUTION_TYPE)
    .map((handle) => ({ handle, result: valueNodeOutput(type, handle.id, data, enumCasesOf) as OutputResult }))
}

/**
 * The value an output of a value node exposes to what is wired to it: the
 * computed value, or nothing while it has an error.
 */
export function valueNodeExposed(
  type: ValueNodeType,
  handleId: string,
  data: Data,
  enumCasesOf: EnumCasesOf,
): Value | undefined {
  const result = valueNodeOutput(type, handleId, data, enumCasesOf)
  return result?.ok ? result.value : undefined
}

function problem(path: string, title: string, detail: string): NodeDataProblem {
  return { path, title, detail }
}

/**
 * What is wrong with a value node's own settings: a value of the wrong type,
 * a value type or an operator it does not have, or Switch cases that are not
 * a list of distinct, non-empty texts each with an id, or a pattern longer
 * than `MAX_PATTERN_LENGTH`. An expression, a template or a pattern that does
 * not parse is not refused here, since it is typed a character at a time: it
 * is the node's check error (`valueNodeCheck`).
 */
export function valueNodeDataProblems(type: ValueNodeType, data: Data): NodeDataProblem[] {
  const has = (key: string) => Object.hasOwn(data, key)
  const notString = (key: string) => has(key) && typeof data[key] !== 'string'
  switch (type) {
    case VALUE_NODE.value:
      return [
        ...(has('valueType') && (typeof data.valueType !== 'string' || data.valueType === '')
          ? [problem('valueType', 'Must be a type', `One of: ${PRIMITIVE_TYPES.join(', ')}, or an enum's type.`)]
          : []),
        ...(has('value') && !isPrimitiveValue(data.value)
          ? [problem('value', 'Must be a text, a number or true or false', 'The value, of the Value’s type.')]
          : []),
      ]
    case VALUE_NODE.convert:
      return valueTypeProblems(data, PRIMITIVE_TYPES)
    case VALUE_NODE.format:
      return notString('template')
        ? [problem('template', 'Must be a string', 'The template, such as {name}_{n:03}.png.')]
        : []
    case VALUE_NODE.mathExpression:
      return notString('expression')
        ? [problem('expression', 'Must be a string', 'The expression, such as a * 2 + 1.')]
        : []
    case VALUE_NODE.textCompare:
      return [
        ...(has('op') && !TEXT_COMPARE_OPERATORS.some((o) => o.id === data.op)
          ? [problem('op', 'Unknown operator', `One of: ${TEXT_COMPARE_OPERATORS.map((o) => o.id).join(', ')}.`)]
          : []),
        ...toggleProblems(data, ['ignoreCase']),
      ]
    case VALUE_NODE.get:
      return valueTypeProblems(data, GET_TYPES)
    case VALUE_NODE.switch:
      return switchCaseProblems(data)
    case VALUE_NODE.regexSearch:
      return patternProblems(data, ['ignoreCase'])
    case VALUE_NODE.regexReplace:
      return patternProblems(data, ['ignoreCase', 'all'])
    default:
      return []
  }
}

// A pattern that does not compile is the node's check error, not refused
// here, as an expression is: it is typed a character at a time.
function patternProblems(data: Data, toggles: readonly string[]): NodeDataProblem[] {
  const detail = `The pattern, in RE2 syntax, at most ${MAX_PATTERN_LENGTH} characters, such as (?<year>\\d{4})-(\\d{2}).`
  const problems: NodeDataProblem[] = []
  if (Object.hasOwn(data, 'pattern') && typeof data.pattern !== 'string') {
    problems.push(problem('pattern', 'Must be a string', detail))
  } else if (stringOf(data, 'pattern').length > MAX_PATTERN_LENGTH) {
    problems.push(problem('pattern', `Longer than ${MAX_PATTERN_LENGTH} characters`, detail))
  }
  return [...problems, ...toggleProblems(data, toggles)]
}

function toggleProblems(data: Data, toggles: readonly string[]): NodeDataProblem[] {
  return toggles
    .filter((key) => Object.hasOwn(data, key) && typeof data[key] !== 'boolean')
    .map((key) => problem(key, 'Must be true or false', `${key} is a toggle on the card.`))
}

function valueTypeProblems(data: Data, allowed: readonly string[]): NodeDataProblem[] {
  if (!Object.hasOwn(data, 'valueType') || allowed.includes(data.valueType as string)) {
    return []
  }
  return [problem('valueType', 'Unknown value type', `One of: ${allowed.join(', ')}.`)]
}

function switchCaseProblems(data: Data): NodeDataProblem[] {
  if (!Object.hasOwn(data, 'cases')) {
    return []
  }
  const cases = data.cases
  const detail =
    'Cases are [{ id, value }], each value a distinct, non-empty text; a case written without an id is given one.'
  if (!Array.isArray(cases)) {
    return [problem('cases', 'Must be a list of cases', detail)]
  }
  const values = new Set<string>()
  const ids = new Set<string>()
  for (const [i, c] of cases.entries()) {
    const at = `cases.${i}`
    if (typeof c !== 'object' || c === null) {
      return [problem(at, 'A case must be { id, value }', detail)]
    }
    if (c.id !== undefined && (typeof c.id !== 'string' || c.id === '')) {
      return [problem(`${at}.id`, 'A case id must be a non-empty string', detail)]
    }
    if (typeof c.value !== 'string' || c.value === '') {
      return [problem(`${at}.value`, 'A case must not be empty', detail)]
    }
    if (values.has(c.value)) {
      return [problem(`${at}.value`, `"${c.value}" is a case already`, detail)]
    }
    if (typeof c.id === 'string' && ids.has(c.id)) {
      return [problem(`${at}.id`, `The id "${c.id}" is taken by another case`, detail)]
    }
    values.add(c.value)
    if (typeof c.id === 'string') {
      ids.add(c.id)
    }
  }
  return []
}

/**
 * `data` with an id given to each Switch case written without one (see
 * `newSwitchCaseId`). Returns `data` itself when every case has one.
 */
export function withSwitchCaseIds(data: Data): Data {
  const cases = data.cases
  if (!Array.isArray(cases) || cases.every((c) => typeof c !== 'object' || c === null || typeof c.id === 'string')) {
    return data
  }
  const given: { id: string }[] = cases.filter((c) => typeof c?.id === 'string')
  const next = cases.map((c) => {
    if (typeof c !== 'object' || c === null || typeof c.id === 'string') {
      return c
    }
    const id = newSwitchCaseId(given)
    given.push({ id })
    return { ...c, id }
  })
  return { ...data, cases: next }
}

/**
 * An id for a new Switch case that no case of the Switch has had: an edge
 * stays on a deleted case's output as a stale pin, and a case given that id
 * again would take the edge over. Random, so it needs no record of the ids
 * deleted cases had; checked against `cases` all the same.
 */
export function newSwitchCaseId(cases: readonly { id: string }[]): string {
  const taken = new Set(cases.map((c) => c.id))
  for (;;) {
    const id = `c${globalThis.crypto.randomUUID().slice(0, 8)}`
    if (!taken.has(id)) {
      return id
    }
  }
}

/**
 * The choices an input feeding `targetHandleId` of `node` starts with: a text
 * Switch's cases, for its condition. Undefined for any other input.
 */
export function choicesFeeding(
  node: { type?: unknown; data?: unknown } | undefined,
  targetHandleId: string | null | undefined,
): ValueOption[] | undefined {
  if (valueNodeTypeOf(node?.type) !== VALUE_NODE.switch || targetHandleId !== 'condition') {
    return undefined
  }
  const data = (node?.data ?? {}) as Record<string, unknown>
  return switchConditionType(data) === STRING_TYPE ? switchCasesOf(data).map((c) => ({ value: c.value })) : undefined
}

/**
 * The node's errors as its data and wiring stand: an output that computes to
 * an error (an expression, a template or a pattern that does not parse, a
 * division by zero, a replacement naming a group the pattern does not have,
 * an input with no value), and an input wired from a type it does not take:
 * a Math Expression variable after an edit of the expression types it
 * otherwise, Get's Fallback after a change of its value type, and an input
 * that takes several types wired from another type than its group has now
 * (two inputs of Select's group fed different types by a change upstream).
 * The outputs read an enum through the cases `enumCasesOf` gives.
 */
export function valueNodeCheck(type: ValueNodeType, data: Data, enumCasesOf: EnumCasesOf): NodeError[] {
  const errors: NodeError[] = []
  const handles = valueNodeHandles(type, data, enumCasesOf)
  const resolved = resolvedInputsOf(data)
  for (const handle of handles) {
    const entry = handle.role === 'target' && Object.hasOwn(resolved, handle.id) ? resolved[handle.id] : undefined
    if (!entry?.handleType) {
      continue
    }
    // Wired, an input that takes several types takes only the one it has now.
    // Connecting into a value input refused every source that is not a value
    // type or an enum, so a source of any other type is an enum, which a text
    // input reads as its text.
    const isEnum = !isValueType(entry.handleType)
    if (!handleTakes(handle, entry.handleType, { isEnum, groupWired: true })) {
      const several = takesSeveralTypes(handle)
      errors.push({
        title: `${handle.label ?? handle.id} is wired from the wrong type`,
        detail: several
          ? `It has the type ${handle.handleType} now and is wired from ${entry.handleType}.`
          : `It takes ${handle.handleType} and is wired from ${entry.handleType}.`,
        next: several
          ? 'Wire it from a value of the type it has now, or wire every input that shares its type from one type.'
          : 'Wire it from a value of the type it takes, or change back the setting that typed it.',
      })
    }
  }
  // One error fails every output of a node whose pattern does not compile: it
  // is listed once. An output that awaits a run is not in error.
  const failing = valueNodeOutputs(type, data, enumCasesOf).filter(({ result }) => !result.ok && !result.awaitsRun)
  for (const error of new Set(failing.map(({ result }) => (result.ok ? '' : result.error)))) {
    const outputs = failing.filter(({ result }) => !result.ok && result.error === error)
    const names = outputs.map(({ handle }) => handle.label ?? handle.id)
    errors.push({
      title: error,
      detail:
        names.length === 1 ? `The ${names[0]} output has no value.` : `The ${names.join(', ')} outputs have no value.`,
    })
  }
  return errors
}
