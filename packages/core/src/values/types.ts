// The value handle types (the three primitives, the object, and the enums
// extensions declare), the rule for which of them connect, and the one reader
// of a value input: wired, typed into the node, or declared. Host-free, so the
// canvas, the server and extensions run the same code: the host tells it an
// enum's cases (`EnumCasesOf`, a handle's `cases`).

/** Text. Carried by a handle as a JSON string. */
export const STRING_TYPE = 'builtin.core.string'
/** A finite number. Carried by a handle as a JSON number; never `NaN` or `Infinity`. */
export const NUMBER_TYPE = 'builtin.core.number'
/** `true` or `false`. */
export const BOOLEAN_TYPE = 'builtin.core.boolean'
/**
 * A JSON object: not an array and not null. It comes from a run (a request's
 * body, an event's payload) and is read with a Get node; nothing is typed into
 * an object input.
 */
export const OBJECT_TYPE = 'builtin.core.object'

/** The three primitive handle types, qualified as graphs store them. */
export const PRIMITIVE_TYPES: readonly string[] = [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE]

/** Every value handle type: the three primitives and the object. */
export const VALUE_TYPES: readonly string[] = [...PRIMITIVE_TYPES, OBJECT_TYPE]

/** A value a primitive handle carries. */
export type PrimitiveValue = string | number | boolean

/** A value an object handle carries. */
export type ObjectValue = Readonly<Record<string, unknown>>

/** A value a value handle carries. */
export type Value = PrimitiveValue | ObjectValue

/** Whether `handleType` (qualified) is one of the three primitive types: the ones a value is typed into. */
export function isPrimitiveType(handleType: string | undefined): boolean {
  return handleType !== undefined && PRIMITIVE_TYPES.includes(handleType)
}

/** Whether `handleType` (qualified) is a value type: a primitive or the object. */
export function isValueType(handleType: string | undefined): boolean {
  return handleType !== undefined && VALUE_TYPES.includes(handleType)
}

/** Whether `value` is what a primitive handle carries: a text, a finite number, or true / false. */
export function isPrimitiveValue(value: unknown): value is PrimitiveValue {
  return typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value)
}

/** Whether `value` is what an object handle carries: a plain object, not an array and not null. */
export function isObjectValue(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether an edge may join a source handle of `sourceType` to a target handle
 * of `targetType` (both qualified): the same type, or a number, a boolean or
 * an enum (`sourceIsEnum`) into a string, which reads it as its text (an
 * enum's as its case's value). Every other change of type is a node of its
 * own (Convert); an object connects only to an object, and
 * nothing but the same enum connects into an enum.
 */
export function handleTypesConnect(sourceType: string, targetType: string, sourceIsEnum = false): boolean {
  if (sourceType === targetType) {
    return true
  }
  return targetType === STRING_TYPE && (sourceType === NUMBER_TYPE || sourceType === BOOLEAN_TYPE || sourceIsEnum)
}

/** One choice of a string input's dropdown, or one case of an enum. */
export interface ValueOption {
  value: string
  label?: string
}

/**
 * The cases of the enum `type` (qualified), in their declared order, or
 * undefined for a type that is not an enum. The host answers it from the
 * handle types its extensions declare (`handleTypes[].cases`).
 */
export type EnumCasesOf = (type: string) => readonly ValueOption[] | undefined

/** An `EnumCasesOf` that knows no enum. */
export const NO_ENUMS: EnumCasesOf = () => undefined

/**
 * What the host adds to a handle of an enum type: the enum's cases, from its
 * declaration (see `withEnumCases`). A handle does not declare it.
 */
export interface EnumCasesField {
  /** The cases of the enum the handle carries; its value is one of their `value`s. */
  cases?: readonly ValueOption[]
}

/** Whether `handle` carries an enum: the host gave it the enum's cases. */
export function isEnumHandle(handle: EnumCasesField): boolean {
  return Array.isArray(handle.cases)
}

/** Whether `handle` carries a value: a primitive, an object, or an enum. */
export function isValueHandle(handle: { handleType: string } & EnumCasesField): boolean {
  return isValueType(handle.handleType) || isEnumHandle(handle)
}

/**
 * `handles` with each one of an enum type given that enum's cases (`cases`),
 * as `enumCasesOf` answers them now. Returns `handles` itself when none
 * carries an enum.
 */
export function withEnumCases<H extends { handleType: string } & EnumCasesField>(
  handles: readonly H[],
  enumCasesOf: EnumCasesOf,
): H[] {
  let changed = false
  const resolved = handles.map((handle) => {
    const cases = isValueType(handle.handleType) ? undefined : enumCasesOf(handle.handleType)
    if (cases === undefined || handle.cases === cases) {
      return handle
    }
    changed = true
    return { ...handle, cases }
  })
  return changed ? resolved : (handles as H[])
}

/** `value` when it is the value of one of `cases`, else undefined. */
function caseValue(cases: readonly ValueOption[], value: unknown): string | undefined {
  return typeof value === 'string' && cases.some((c) => c.value === value) ? value : undefined
}

/**
 * What a target handle of a primitive type may declare about the value typed
 * into it on the node's card (`data.inputs.<handle id>`). All optional: a
 * handle that declares none takes a typed value with no default.
 */
export interface InlineValueFields {
  /** `false`: the input takes no typed value and must be wired. */
  inline?: boolean
  /** The value read while nothing is typed and nothing is wired. */
  default?: PrimitiveValue
  /** A number input takes whole numbers; a value read through it is rounded to the nearest one. */
  integer?: boolean
  min?: number
  max?: number
  step?: number
  /** A string input's choices, shown as a dropdown. */
  options?: ValueOption[]
  /** A string input's field is a text area. */
  multiline?: boolean
}

/**
 * What a target handle of a value type may declare about the types it takes.
 * Without `accepts` it takes its one `handleType` (see `handleTypesConnect`).
 */
export interface AcceptedTypes {
  /**
   * Every value type the input takes, `handleType` among them. Its type is
   * then set by what is connected into it (see `inputTypeOf`), and it takes
   * exactly these types: nothing widens into it.
   */
  accepts?: string[]
  /** It takes every enum too. */
  acceptsEnums?: boolean
  /**
   * Inputs of one node that share one type name the same group: connecting
   * into any of them sets the type of all. Without it the input is a group of
   * its own, named by its id.
   */
  typeGroup?: string
}

/**
 * A target handle as the values module reads it: its declaration, with `id`
 * the handle's own id on the node (for a dynamic handle, the id on the node,
 * not the declared prefix).
 */
export interface ValueHandle extends InlineValueFields, AcceptedTypes, EnumCasesField {
  id: string
  handleType: string
  label?: string
}

/**
 * The key of a node's data holding the type each of its several-type input
 * groups has now, by group: `data.inputTypes.<group>`. Written by connecting
 * and kept in step with what feeds the input; never by hand.
 */
export const INPUT_TYPES_KEY = 'inputTypes'

/** Whether `handle` takes several types: it declares `accepts`. */
export function takesSeveralTypes(handle: AcceptedTypes): boolean {
  return Array.isArray(handle.accepts) && handle.accepts.length > 0
}

/** The type group of an input: its `typeGroup`, else its own id. */
export function typeGroupOf(handle: { id: string } & AcceptedTypes): string {
  return handle.typeGroup ?? handle.id
}

/** The types each input group has now, `data.inputTypes`, as stored: empty when there are none. */
export function inputTypesOf(data: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const stored = data?.[INPUT_TYPES_KEY]
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

/**
 * The type a several-type input has now: the one stored for its group when
 * the input accepts it, else its `handleType`, the type it has before
 * anything is connected. An input that takes one type has that type.
 *
 * An input that takes every enum (`acceptsEnums`) takes a stored type that
 * is not one of the value types as an enum, without being told the enums:
 * only connecting writes the type (`dataOnConnect`), and it writes one the
 * input does not list only for a source the host knows as an enum. One whose
 * extension is gone since keeps the type, as an edge keeps a handle that is
 * gone.
 */
export function inputTypeOf(
  data: Readonly<Record<string, unknown>> | undefined,
  handle: { id: string; handleType: string } & AcceptedTypes,
): string {
  if (!takesSeveralTypes(handle)) {
    return handle.handleType
  }
  const groups = inputTypesOf(data)
  const group = typeGroupOf(handle)
  const stored = Object.hasOwn(groups, group) ? groups[group] : undefined
  if (stored === undefined) {
    return handle.handleType
  }
  return handleAccepts(handle, stored, !isValueType(stored)) ? stored : handle.handleType
}

/**
 * `handles` with each several-type input's `handleType` the type it has now
 * in a node with `data` (see `inputTypeOf`), its `accepts` kept: the form
 * every reader of a node's handles reads them in. Returns `handles` itself
 * when none changes.
 */
export function withTypesNow<H extends { id: string; handleType: string; role?: string } & AcceptedTypes>(
  handles: readonly H[],
  data: Readonly<Record<string, unknown>> | undefined,
): H[] {
  let changed = false
  const now = handles.map((handle) => {
    if (handle.role === 'source' || !takesSeveralTypes(handle)) {
      return handle
    }
    const handleType = inputTypeOf(data, handle)
    if (handleType === handle.handleType) {
      return handle
    }
    changed = true
    return { ...handle, handleType }
  })
  return changed ? now : (handles as H[])
}

/**
 * `data` with the type of the input group `group` set to `type`, or `data`
 * itself when it has that type stored already.
 */
export function withInputType(
  data: Readonly<Record<string, unknown>>,
  group: string,
  type: string,
): Readonly<Record<string, unknown>> {
  const groups = inputTypesOf(data)
  if (groups[group] === type) {
    return data
  }
  return { ...data, [INPUT_TYPES_KEY]: { ...groups, [group]: type } }
}

function handleAccepts(handle: AcceptedTypes, type: string, isEnum = false): boolean {
  return (handle.accepts ?? []).includes(type) || (isEnum && handle.acceptsEnums === true)
}

/**
 * Whether a target `handle` takes an edge from a source of `sourceType`
 * (qualified). `isEnum`: the source's type is an enum. An input that takes
 * one type follows `handleTypesConnect`, so a text input takes an enum. A
 * several-type input takes exactly what it accepts, every enum among them
 * with `acceptsEnums`, and while another input of its type group is wired
 * (`groupWired`), only the type the group has now, its `handleType` as
 * `withTypesNow` gives it.
 */
export function handleTakes(
  handle: { handleType: string } & AcceptedTypes,
  sourceType: string,
  { isEnum = false, groupWired = false }: { isEnum?: boolean; groupWired?: boolean } = {},
): boolean {
  if (!takesSeveralTypes(handle)) {
    return handleTypesConnect(sourceType, handle.handleType, isEnum)
  }
  if (groupWired) {
    return sourceType === handle.handleType
  }
  return handleAccepts(handle, sourceType, isEnum)
}

/**
 * The values `handle` takes, for a sentence: `a number or true/false`; an
 * enum's by its cases' labels, `PNG, JPEG or WebP`.
 */
export function acceptedTypesPhrase(handle: { handleType: string } & AcceptedTypes & EnumCasesField): string {
  if (!takesSeveralTypes(handle) && handle.cases) {
    return orList(handle.cases.map((c) => c.label ?? c.value))
  }
  const types = takesSeveralTypes(handle) ? (handle.accepts as string[]) : [handle.handleType]
  return orList([...types.map(valueTypePhrase), ...(handle.acceptsEnums ? ['an enum'] : [])])
}

function orList(named: readonly string[]): string {
  return named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}`
}

function valueTypePhrase(type: string): string {
  if (type === NUMBER_TYPE) {
    return 'a number'
  }
  if (type === BOOLEAN_TYPE) {
    return 'true/false'
  }
  if (type === OBJECT_TYPE) {
    return 'an object'
  }
  return type === STRING_TYPE ? 'a text' : type
}

/**
 * What is wired into an input: `{ value }` when its source exposes a value,
 * `null` when it is wired and its source exposes nothing, `undefined` when
 * nothing is wired.
 */
export type WiredValue = { value: unknown } | null | undefined

/** A value as text: a string as is, a number in its shortest decimal form (`42`, `0.5`), a boolean as `true` / `false`. */
export function valueAsText(value: PrimitiveValue): string {
  return String(value)
}

/**
 * `value` read through a handle of `handle`'s type, or undefined when it is not
 * a value of that type: a number or a boolean read by a string handle becomes
 * its text, a number read by an `integer` handle is rounded, and an enum
 * handle reads one of its `cases`' values.
 */
export function readValue(
  handle: Pick<ValueHandle, 'handleType' | 'integer' | 'cases'>,
  value: unknown,
): Value | undefined {
  if (handle.cases && !isValueType(handle.handleType)) {
    return caseValue(handle.cases, value)
  }
  switch (handle.handleType) {
    case OBJECT_TYPE:
      return isObjectValue(value) ? value : undefined
    case STRING_TYPE:
      if (typeof value === 'string') {
        return value
      }
      return isFiniteNumber(value) || typeof value === 'boolean' ? valueAsText(value) : undefined
    case NUMBER_TYPE:
      if (!isFiniteNumber(value)) {
        return undefined
      }
      return handle.integer ? Math.round(value) : value
    case BOOLEAN_TYPE:
      return typeof value === 'boolean' ? value : undefined
    default:
      return undefined
  }
}

/**
 * The value a value input reads, the first of:
 * 1. the wired value, read through the handle's type (`readValue`); an input
 *    that is wired reads nothing else, even while its source exposes nothing;
 * 2. the value typed into the node, `data.inputs[handle.id]`, unless the
 *    handle says `inline: false`; an object input takes none;
 * 3. the handle's declared `default`;
 * 4. nothing (undefined).
 *
 * On an input that takes several types, `handle.handleType` is its type now
 * (see `withTypesNow`), and a typed value or a default of another of its
 * types is kept and not read: nothing is read as its text there.
 */
export function inputValue(
  data: Readonly<Record<string, unknown>> | undefined,
  handle: ValueHandle,
  wired?: WiredValue,
): Value | undefined {
  if (wired !== undefined) {
    return wired === null ? undefined : readValue(handle, wired.value)
  }
  const ownValue = (value: unknown) =>
    takesSeveralTypes(handle) && !hasValueType(handle, value) ? undefined : readValue(handle, value)
  if (handle.inline !== false && handle.handleType !== OBJECT_TYPE) {
    const typed = typedValueOf(data, handle.id)
    const read = typed === undefined ? undefined : ownValue(typed)
    if (read !== undefined) {
      return read
    }
  }
  return handle.default === undefined ? undefined : ownValue(handle.default)
}

// Whether `value` is a value of `handle`'s type as it is, read through nothing.
function hasValueType(handle: Pick<ValueHandle, 'handleType' | 'cases'>, value: unknown): boolean {
  switch (handle.handleType) {
    case STRING_TYPE:
      return typeof value === 'string'
    case NUMBER_TYPE:
      return isFiniteNumber(value)
    case BOOLEAN_TYPE:
      return typeof value === 'boolean'
    default:
      return handle.cases !== undefined && caseValue(handle.cases, value) !== undefined
  }
}

/** The value typed into the node for `handleId`, as stored at `data.inputs[handleId]`. */
export function typedValueOf(data: Readonly<Record<string, unknown>> | undefined, handleId: string): unknown {
  const inputs = data?.inputs
  if (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs) || !Object.hasOwn(inputs, handleId)) {
    return undefined
  }
  return (inputs as Record<string, unknown>)[handleId]
}

/**
 * What is wrong with `value` as the typed value of `handle`, as a phrase that
 * follows the field's name (`must be a number`), or null when it is valid.
 * Checks the type, and for a number `integer`, `min` and `max`, for a string
 * `options`, for an enum its `cases`. An object input takes no typed value at
 * all. An input that takes several types takes a value of any of them, kept
 * across a change of its type, except while it is on an enum: then it takes
 * only one of the enum's cases, as a value of another type, or a case the
 * enum no longer has, reads as nothing there (`inputValue`).
 */
export function typedValueProblem(handle: ValueHandle, value: unknown): string | null {
  if (takesSeveralTypes(handle) && !isEnumHandle(handle)) {
    const own = typeProblem(handle, value)
    const other = (handle.accepts as string[]).some(
      (handleType) =>
        handleType !== handle.handleType && typeProblem({ ...handle, handleType, cases: undefined }, value) === null,
    )
    return own === null || other ? null : own
  }
  return typeProblem(handle, value)
}

function typeProblem(handle: ValueHandle, value: unknown): string | null {
  if (handle.cases && !isValueType(handle.handleType)) {
    return caseValue(handle.cases, value) === undefined
      ? `must be one of: ${handle.cases.map((c) => c.value).join(', ')}`
      : null
  }
  switch (handle.handleType) {
    case OBJECT_TYPE:
      return 'takes no typed value: connect an object to it'
    case STRING_TYPE:
      if (typeof value !== 'string') {
        return 'must be a string'
      }
      if (handle.options && handle.options.length > 0 && !handle.options.some((option) => option.value === value)) {
        return `must be one of: ${handle.options.map((option) => option.value).join(', ')}`
      }
      return null
    case NUMBER_TYPE:
      if (!isFiniteNumber(value)) {
        return 'must be a number'
      }
      if (handle.integer && !Number.isInteger(value)) {
        return 'must be a whole number'
      }
      if (handle.min !== undefined && value < handle.min) {
        return `must be at least ${handle.min}`
      }
      if (handle.max !== undefined && value > handle.max) {
        return `must be at most ${handle.max}`
      }
      return null
    case BOOLEAN_TYPE:
      return typeof value === 'boolean' ? null : 'must be true or false'
    default:
      return null
  }
}

/** One case of a Switch on a text: `id` names its output, `case-<id>`, and never changes. */
export interface SwitchCase {
  id: string
  value: string
}

/**
 * What `switchOutput` reads of a Switch's data: the type its `condition` has
 * now, `inputTypes.condition` (absent: boolean), and, for a text, its cases.
 */
export interface SwitchSettings {
  inputTypes?: unknown
  cases?: unknown
}

/**
 * The types a Switch's condition lists, the first the one it has before
 * anything is connected. It takes every enum as well (`acceptsEnums`).
 */
export const SWITCH_CONDITION_TYPES: readonly string[] = [BOOLEAN_TYPE, STRING_TYPE]

// What a Switch's condition declares about the types it takes.
const SWITCH_CONDITION: Readonly<{ handleType: string } & AcceptedTypes> = {
  handleType: BOOLEAN_TYPE,
  accepts: [...SWITCH_CONDITION_TYPES],
  acceptsEnums: true,
}

/**
 * The type a Switch's condition has now: the type connected into it last
 * (a boolean, a text or an enum), boolean while there was none.
 */
export function switchConditionType(settings: SwitchSettings): string {
  return inputTypeOf(settings as Record<string, unknown>, { id: 'condition', ...SWITCH_CONDITION })
}

export type SwitchOutputResult = { ok: true; output: string } | { ok: false; error: string }

/** The output of a Switch's text case `id`, or of an enum case by its value. */
export function switchCaseOutput(id: string): string {
  return `case-${id}`
}

/** A Switch's text cases as stored, with anything malformed left out. */
export function switchCasesOf(settings: SwitchSettings): SwitchCase[] {
  return Array.isArray(settings.cases)
    ? settings.cases.filter(
        (c): c is SwitchCase =>
          typeof c === 'object' && c !== null && typeof c.id === 'string' && c.id !== '' && typeof c.value === 'string',
      )
    : []
}

/**
 * The output a Switch routes `value` to: for a boolean Switch `exec-true` or
 * `exec-false`; for a text Switch the output of the first case whose value is
 * `value` exactly, else `exec-default`; for a Switch on an enum, with that
 * enum's `enumCases`, the output of the case whose value is `value`, else
 * `exec-default`, whatever the value is: a typed value the enum no longer
 * has as a case among them (the node's data error names the cases, see
 * `typedValueProblem`). No value is
 * an error, and so is any other value on a boolean Switch.
 */
export function switchOutput(
  settings: SwitchSettings,
  value: unknown,
  enumCases: readonly ValueOption[] = [],
): SwitchOutputResult {
  if (value === undefined) {
    return { ok: false, error: 'condition has no value' }
  }
  const type = switchConditionType(settings)
  if (!isValueType(type)) {
    const match = caseValue(enumCases, value)
    return { ok: true, output: match === undefined ? 'exec-default' : switchCaseOutput(match) }
  }
  if (typeof value === 'boolean') {
    return { ok: true, output: value ? 'exec-true' : 'exec-false' }
  }
  if (type === BOOLEAN_TYPE) {
    const kind = typeof value === 'string' ? 'a text' : 'a number'
    return { ok: false, error: `condition is ${kind}, and a boolean Switch routes on true or false` }
  }
  const match = switchCasesOf(settings).find((c) => c.value === value)
  return { ok: true, output: match ? switchCaseOutput(match.id) : 'exec-default' }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
