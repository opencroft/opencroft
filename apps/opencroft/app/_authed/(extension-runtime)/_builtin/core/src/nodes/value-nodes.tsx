import {
  enumHandleTypes,
  handleTypeOf,
  InputHandle,
  NodeFrame,
  OutputHandle,
  useLiveNodeData,
  useUpdateNodeData,
  useUpdateNodeInternals,
} from '@opencroft/client/canvas'
import { Flex, NodeValueInput, type NodeValueKind } from '@opencroft/client/ui'
import {
  awaitingRunOf,
  BOOLEAN_TYPE,
  type EnumCasesOf,
  NO_ENUMS,
  NUMBER_TYPE,
  PRIMITIVE_TYPES,
  type PrimitiveValue,
  STRING_TYPE,
  type Value,
} from '@opencroft/client/values'
import type { LucideIcon } from 'lucide-react'
import {
  ArrowRightLeft,
  Braces,
  Calculator,
  CaseSensitive,
  GitFork,
  Pi,
  Regex,
  Replace,
  TextSearch,
} from 'lucide-react'
import { type ReactNode, useEffect } from 'react'

import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { PinColumns } from './pin-columns'
import {
  convertTypeOf,
  defaultValueOf,
  GET_TYPES,
  type OutputResult,
  patternOf,
  replacesAll,
  TEXT_COMPARE_OPERATORS,
  VALUE_NODE,
  type ValueNodeType,
  valueNodeExposed,
  valueNodeHandles,
  valueNodeOutputs,
  valueTypeLabel,
  valueTypeOfValueNode,
  WHEN_IT_RUNS,
} from './value-nodes-shared'

type Data = Record<string, unknown>

interface CardProps {
  id: string
  data: Data
  selected?: boolean
}

/** Re-measures the node when the handles its data gives it change, so React Flow knows where new pins are. */
export function useHandlesFollowData(id: string, handles: readonly ExtensionHandle[]) {
  const updateNodeInternals = useUpdateNodeInternals()
  const key = handles.map((h) => `${h.role}:${h.id}:${h.handleType}`).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is only a re-run trigger, the effect does not read it
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, key, updateNodeInternals])
}

/**
 * The label of an input pin; the host draws the value field after it while
 * nothing is wired. A wired input that has a value only while a run
 * dispatches (`awaitsRun`) says so in its pin's tooltip.
 */
export function InputRow({ handle, awaitsRun }: { handle: ExtensionHandle; awaitsRun?: boolean }) {
  return (
    <InputHandle type={handle.handleType} id={handle.id} tip={awaitsRun ? WHEN_IT_RUNS : undefined}>
      <span className='shrink-0 truncate text-[10px] text-muted-foreground'>{handle.label ?? handle.id}</span>
    </InputHandle>
  )
}

/**
 * What an output computes now, or why it has nothing (When it runs, for one
 * that awaits a run): the tooltip of its pin. The card draws neither, so it
 * keeps its size whatever the value.
 */
function outputTip(result: OutputResult): ReactNode {
  return result.ok ? <span className='font-mono tabular-nums'>{shownValue(result.value)}</span> : result.error
}

/** An output pin and its label; what it computes is its pin's tooltip. */
function OutputRow({ handle, result }: { handle: ExtensionHandle; result: OutputResult }) {
  return (
    <OutputHandle type={handle.handleType} id={handle.id} tip={outputTip(result)}>
      <span className='shrink-0 text-[10px] text-muted-foreground'>{handle.label ?? handle.id}</span>
    </OutputHandle>
  )
}

// The field a Value's value is typed in, as an input's is beside its pin:
// text in a text area, a number in a number field, a boolean as a toggle, an
// enum as a dropdown of its cases.
const VALUE_KINDS: Readonly<Record<string, NodeValueKind>> = {
  [STRING_TYPE]: 'text',
  [NUMBER_TYPE]: 'number',
  [BOOLEAN_TYPE]: 'boolean',
}

/**
 * A Value's output pin with its value edited in place. A value that is not of
 * the Value's type shows an empty field, and the pin's tooltip says why.
 */
function ValueOutputRow({
  handle,
  result,
  onCommit,
}: {
  handle: ExtensionHandle
  result: OutputResult
  onCommit: (value: PrimitiveValue) => void
}) {
  const label = handle.label ?? handle.id
  const kind = VALUE_KINDS[handle.handleType] ?? 'text'
  const cases = loadedEnumCases(handle.handleType)
  const options = cases?.map((c) => ({ value: c.value, label: c.label }))
  return (
    <OutputHandle type={handle.handleType} id={handle.id} tip={outputTip(result)}>
      {/* A press in the field edits it; it does not drag the node or pan the
          canvas. The field takes the card's width and never widens it: a
          text area sizes itself to what is typed, and inline-size containment
          keeps that out of the card's own width. */}
      <div className='nodrag nopan min-w-0 flex-1 contain-inline-size'>
        <NodeValueInput
          kind={kind}
          label={label}
          // A Value holds a text, a number or a boolean.
          value={result.ok ? (result.value as PrimitiveValue) : undefined}
          options={options}
          multiline={kind === 'text' && !options}
          onCommit={onCommit}
        />
      </div>
      <span className='shrink-0 text-[10px] text-muted-foreground'>{label}</span>
    </OutputHandle>
  )
}

/** The longest an object's JSON is shown in a tooltip before it is cut. */
const SHOWN_OBJECT_LENGTH = 200

function shownValue(value: Value): string {
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return json.length > SHOWN_OBJECT_LENGTH ? `${json.slice(0, SHOWN_OBJECT_LENGTH)}…` : json
  }
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/** A text setting edited on the card: a field that commits on Enter or when it loses focus, or a dropdown. */
function SettingField({
  label,
  value,
  options,
  monospace,
  onCommit,
}: {
  label: string
  value: PrimitiveValue | undefined
  options?: { value: string; label?: string }[]
  monospace?: boolean
  onCommit: (value: PrimitiveValue) => void
}) {
  return (
    // A press in the field edits it; it does not drag the node or pan the canvas.
    <div className='nodrag nopan min-w-0'>
      <NodeValueInput
        kind='text'
        label={label}
        value={value}
        options={options}
        monospace={monospace}
        onCommit={onCommit}
      />
    </div>
  )
}

/** A true / false setting edited on the card: a toggle, then its name. */
function SettingToggle({
  label,
  value,
  onCommit,
}: {
  label: string
  value: boolean
  onCommit: (value: PrimitiveValue) => void
}) {
  return (
    // A press on the toggle switches it; it does not drag the node or pan the canvas.
    <Flex row withGaps align='center' className='nodrag nopan'>
      <NodeValueInput kind='boolean' label={label} value={value} onCommit={onCommit} />
      <span className='text-[10px] text-muted-foreground'>{label}</span>
    </Flex>
  )
}

// The pattern of a Regex Search or Replace, in the monospace font, and its
// toggles. A Search whose pattern has a numbered group says how to keep that
// group's wire: its output moves when a group is added before it.
function PatternSettings({ type, data, update }: { type: ValueNodeType; data: Data; update: (patch: Data) => void }) {
  const compiled = patternOf(data)
  const numbered =
    type === VALUE_NODE.regexSearch && compiled.ok && compiled.pattern.groups.some((g) => g.name === undefined)
  return (
    <Flex withGaps>
      <SettingField
        label='Pattern'
        value={stringValue(data.pattern)}
        monospace
        onCommit={(pattern) => update({ pattern })}
      />
      {numbered && (
        <span className='text-[10px] text-muted-foreground'>
          Name a group, <code className='font-mono'>{'(?<year>…)'}</code>, to keep its wire when the pattern changes.
        </span>
      )}
      <Flex row withGaps>
        <SettingToggle
          label='Ignore case'
          value={data.ignoreCase === true}
          onCommit={(ignoreCase) => update({ ignoreCase })}
        />
        {type === VALUE_NODE.regexReplace && (
          <SettingToggle label='Replace all' value={replacesAll(data)} onCommit={(all) => update({ all })} />
        )}
      </Flex>
    </Flex>
  )
}

const typeOptions = (types: readonly string[]) => types.map((value) => ({ value, label: valueTypeLabel(value) }))

// The types a Value can hold: text, a number, a boolean and every enum the
// loaded extensions declare, with `current` kept when no loaded extension
// declares it, so the dropdown still shows it.
function valueTypeOptions(current: string): { value: string; label?: string }[] {
  const options = [
    ...typeOptions(PRIMITIVE_TYPES),
    ...enumHandleTypes().map((enumType) => ({ value: enumType.id, label: enumType.label ?? enumType.id })),
  ]
  return options.some((option) => option.value === current) ? options : [...options, { value: current }]
}

const ICONS: Record<Exclude<ValueNodeType, 'switch'>, { icon: LucideIcon; title: string }> = {
  [VALUE_NODE.value]: { icon: Pi, title: 'Value' },
  [VALUE_NODE.convert]: { icon: ArrowRightLeft, title: 'Convert' },
  [VALUE_NODE.format]: { icon: Braces, title: 'Format' },
  [VALUE_NODE.mathExpression]: { icon: Calculator, title: 'Math Expression' },
  [VALUE_NODE.textCompare]: { icon: CaseSensitive, title: 'Text Compare' },
  [VALUE_NODE.select]: { icon: GitFork, title: 'Select' },
  [VALUE_NODE.regexSearch]: { icon: Regex, title: 'Regex Search' },
  [VALUE_NODE.regexReplace]: { icon: Replace, title: 'Regex Replace' },
  [VALUE_NODE.get]: { icon: TextSearch, title: 'Get' },
}

// The nodes whose settings sit below their pins: what they compute reads from
// their inputs first ("A contains B", a value then its type).
const SETTINGS_BELOW: readonly ValueNodeType[] = [VALUE_NODE.value, VALUE_NODE.convert, VALUE_NODE.textCompare]

// The card of every pure value node: its settings and its pins, inputs on
// the left and outputs on the right from the first row (`PinColumns`). What
// an output computes now from the inputs as the canvas has them wired
// (`useLiveNodeData`), by the function `exposeOutput` uses, is its pin's
// tooltip, so the card keeps its size; a Value's output is where its value
// is typed.
function makeValueCard(type: Exclude<ValueNodeType, 'switch'>) {
  const { icon, title } = ICONS[type]
  const below = SETTINGS_BELOW.includes(type)
  return function ValueCard({ id, data, selected }: CardProps) {
    const live = useLiveNodeData(id) ?? data
    const handles = valueNodeHandles(type, data, loadedEnumCases)
    useHandlesFollowData(id, handles)
    const update = useUpdateNodeData(id)
    const inputs = handles.filter((h) => h.role === 'target')
    const awaited = awaitingRunOf(live)
    const outputs = valueNodeOutputs(type, live, loadedEnumCases).map(({ handle, result }) =>
      type === VALUE_NODE.value ? (
        <ValueOutputRow key={handle.id} handle={handle} result={result} onCommit={(value) => update({ value })} />
      ) : (
        <OutputRow key={handle.id} handle={handle} result={result} />
      ),
    )
    const settings = <Settings type={type} data={data} update={update} />
    const inputRows = inputs.map((handle) => (
      <InputRow key={handle.id} handle={handle} awaitsRun={awaited.includes(handle.id)} />
    ))
    return (
      <NodeFrame icon={icon} title={title} selected={selected ?? false}>
        <Flex withGaps className='min-w-48'>
          {!below && settings}
          <PinColumns inputs={inputRows} outputs={outputs} />
          {below && settings}
        </Flex>
      </NodeFrame>
    )
  }
}

function Settings({
  type,
  data,
  update,
}: {
  type: ValueNodeType
  data: Data
  update: (patch: Data) => void
}): ReactNode {
  const commit = (key: string) => (value: PrimitiveValue) => update({ [key]: value })
  switch (type) {
    case VALUE_NODE.value: {
      const current = valueTypeOfValueNode(data)
      return (
        <SettingField
          label='Type'
          value={current}
          options={valueTypeOptions(current)}
          // A new type starts from its default: a value of the old type is not one of the new.
          onCommit={(valueType) => {
            const value = defaultValueOf(String(valueType), loadedEnumCases)
            update(value === undefined ? { valueType } : { valueType, value })
          }}
        />
      )
    }
    case VALUE_NODE.convert:
      return (
        <SettingField
          label='To'
          value={convertTypeOf(data)}
          options={typeOptions(PRIMITIVE_TYPES)}
          onCommit={commit('valueType')}
        />
      )
    case VALUE_NODE.format:
      return <SettingField label='Template' value={stringValue(data.template)} onCommit={commit('template')} />
    case VALUE_NODE.mathExpression:
      return <SettingField label='Expression' value={stringValue(data.expression)} onCommit={commit('expression')} />
    case VALUE_NODE.textCompare:
      return (
        <Flex withGaps>
          <SettingField
            label='Operator'
            value={typeof data.op === 'string' ? data.op : TEXT_COMPARE_OPERATORS[0].id}
            options={TEXT_COMPARE_OPERATORS.map((o) => ({ value: o.id, label: o.label }))}
            onCommit={commit('op')}
          />
          <SettingToggle label='Ignore case' value={data.ignoreCase === true} onCommit={commit('ignoreCase')} />
        </Flex>
      )
    case VALUE_NODE.get:
      return (
        <SettingField
          label='Value type'
          value={typeof data.valueType === 'string' ? data.valueType : GET_TYPES[0]}
          options={typeOptions(GET_TYPES)}
          onCommit={commit('valueType')}
        />
      )
    case VALUE_NODE.regexSearch:
    case VALUE_NODE.regexReplace:
      return <PatternSettings type={type} data={data} update={update} />
    default:
      return null
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export const ValueNode = makeValueCard(VALUE_NODE.value)
export const ConvertNode = makeValueCard(VALUE_NODE.convert)
export const FormatNode = makeValueCard(VALUE_NODE.format)
export const MathExpressionNode = makeValueCard(VALUE_NODE.mathExpression)
export const TextCompareNode = makeValueCard(VALUE_NODE.textCompare)
export const SelectNode = makeValueCard(VALUE_NODE.select)
export const RegexSearchNode = makeValueCard(VALUE_NODE.regexSearch)
export const RegexReplaceNode = makeValueCard(VALUE_NODE.regexReplace)
export const GetNode = makeValueCard(VALUE_NODE.get)

/** The settings are on the card. */
export function ValueNodeInspector() {
  return null
}

/** The cases of an enum the loaded extensions declare (`EnumCasesOf`), for the cards' handles. */
export const loadedEnumCases: EnumCasesOf = (type) => handleTypeOf(type)?.cases

/** The handles a value node's type declares, for the palette and the agents' listing; a node's own follow its data. */
export function valueNodeTypeHandles(type: ValueNodeType): ExtensionHandle[] {
  return valueNodeHandles(type, {}, NO_ENUMS).map((h) => ({
    ...h,
    handleType: bareType(h.handleType),
    ...(h.accepts ? { accepts: h.accepts.map(bareType) } : {}),
  }))
}

// Core declares its handle types bare, as an extension declares its own.
function bareType(type: string): string {
  return type.startsWith('builtin.core.') ? type.slice('builtin.core.'.length) : type
}

/** `exposeOutput` of a value node: what an output computes to, nothing while it has an error. */
export function valueNodeExposeOutput(type: ValueNodeType) {
  return (handleId: string, data: Data) => valueNodeExposed(type, handleId, data, loadedEnumCases)
}
