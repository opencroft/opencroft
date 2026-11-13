// What a Subgraph stores, and the handles its ports make. A subgraph is a node
// that opens as a canvas of its own: the nodes inside it carry `parentId` set
// to it (see `_frame-tree.ts`), and its inputs and outputs are the ports in
// `data.ports`, the one record of them. A port is a handle on both sides: an
// input port `p` is the target handle `in-p` on the card and the source handle
// `in-p` inside, on the Inputs boundary; an output port is the reverse with
// `out-p`. Reordering ports never changes a handle id, so edges stay connected.
//
// An input port of a value type takes a value typed on the card, as any value
// input does (`data.inputs.in-<id>`): see `portValueOf`.
//
// Pure: no runtime imports.

import {
  inputTypeOf,
  inputValue,
  isPrimitiveType,
  isPrimitiveValue,
  isValueType,
  type PrimitiveValue,
  STRING_TYPE,
  typedValueOf,
  VALUE_TYPES,
  type ValueOption,
} from '@opencroft/core/values'

import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'

/** The node type of the core Subgraph. */
export const SUBGRAPH_TYPE = 'builtin.core.subgraph'

export interface SubgraphPort {
  /** Unique among the subgraph's ports and never changed: the handle ids are made from it. */
  id: string
  label: string
  /**
   * The qualified type of what the port carries: the type of the first handle
   * it was connected to inside. An output port of a value type follows the
   * type of the inner source feeding it.
   */
  handleType: string
  /**
   * For an input port made from an input that takes several types: the types
   * it takes, `handleType` among them. Its type is then the one connected
   * into it outside, `data.inputTypes.in-<id>` (see `inputTypeOf`).
   */
  accepts?: string[]
  /** For an input port made from an input that takes every enum: so does the port. */
  acceptsEnums?: boolean
  /** For an input port: it takes any number of edges on the card. */
  multiple?: boolean
  /**
   * For a text input port: the values it takes. Its value on the card is then
   * a dropdown of them, and a typed value outside them is refused on write.
   */
  options?: ValueOption[]
}

export interface SubgraphPorts {
  inputs: SubgraphPort[]
  outputs: SubgraphPort[]
}

export interface SubgraphData {
  name: string
  ports: SubgraphPorts
  /** Where the Inputs boundary is drawn on the inner canvas; a write that finds it absent puts it left of the contents. */
  inputsAt?: { x: number; y: number }
  /** Where the Outputs boundary is drawn on the inner canvas; a write that finds it absent puts it right of the contents. */
  outputsAt?: { x: number; y: number }
}

export type PortSide = 'inputs' | 'outputs'

/** The name a subgraph is shown by. */
export function subgraphName(data: unknown): string {
  return (data as Partial<SubgraphData> | undefined)?.name || 'Subgraph'
}

/** Whether `node` is a subgraph. */
export function isSubgraph(node: { type?: unknown } | undefined): boolean {
  return node?.type === SUBGRAPH_TYPE
}

/** The handle id of `port` on `side`: the same on the card and inside. */
export function portHandleId(side: PortSide, portId: string): string {
  return `${side === 'inputs' ? 'in' : 'out'}-${portId}`
}

/** The port a handle id names, or null for an id that is not a port handle. */
export function portOfHandle(handleId: string): { side: PortSide; portId: string } | null {
  if (handleId.startsWith('in-')) {
    return { side: 'inputs', portId: handleId.slice(3) }
  }
  if (handleId.startsWith('out-')) {
    return { side: 'outputs', portId: handleId.slice(4) }
  }
  return null
}

function asPorts(value: unknown): SubgraphPort[] {
  return Array.isArray(value)
    ? value.filter(
        (p): p is SubgraphPort =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as SubgraphPort).id === 'string' &&
          (p as SubgraphPort).id !== '' &&
          typeof (p as SubgraphPort).handleType === 'string',
      )
    : []
}

/** A subgraph's ports as stored, with anything malformed left out. */
export function portsOf(data: unknown): SubgraphPorts {
  const ports = (data as { ports?: Partial<Record<PortSide, unknown>> } | undefined)?.ports
  return { inputs: asPorts(ports?.inputs), outputs: asPorts(ports?.outputs) }
}

/** The port `handleId` names on a subgraph with `data`, if it exists. */
export function findPort(data: unknown, handleId: string): (SubgraphPort & { side: PortSide }) | undefined {
  const named = portOfHandle(handleId)
  if (!named) {
    return undefined
  }
  const port = portsOf(data)[named.side].find((p) => p.id === named.portId)
  return port ? { ...port, side: named.side } : undefined
}

/**
 * The value typed on a subgraph's card into its input port `handleId`
 * (`data.inputs.<handle id>`), read through the port's type, or undefined
 * when the port carries no value type or nothing of its type is typed. While
 * nothing outside feeds the port, the nodes it feeds inside read this.
 */
export function portValueOf(data: unknown, handleId: string): PrimitiveValue | undefined {
  const port = findPort(data, handleId)
  if (port?.side !== 'inputs') {
    return undefined
  }
  const handleType = portTypeOf(data, port)
  if (!isPrimitiveType(handleType)) {
    return undefined
  }
  // Read as any typed value is: one of another of the port's types is kept and not read.
  const read = inputValue(data as Record<string, unknown> | undefined, { ...port, id: handleId, handleType })
  return isPrimitiveValue(read) ? read : undefined
}

/** The type an input port has now: the type connected into it outside when it takes several (see `inputTypeOf`). */
function portTypeOf(data: unknown, port: SubgraphPort): string {
  return inputTypeOf(data as Record<string, unknown> | undefined, { ...port, id: portHandleId('inputs', port.id) })
}

/**
 * The handles of a subgraph's card, in the ports' order: a target per input
 * port, taking several edges when the port says so, the types it accepts,
 * and only its choices while it is a text, and a source per output.
 */
export function subgraphHandles(data: unknown): ExtensionHandle[] {
  const { inputs, outputs } = portsOf(data)
  return [
    ...inputs.map((p) => ({
      id: portHandleId('inputs', p.id),
      handleType: p.handleType,
      role: 'target' as const,
      label: p.label,
      ...(p.accepts && p.accepts.length > 0 ? { accepts: [...p.accepts] } : {}),
      ...(p.acceptsEnums ? { acceptsEnums: true } : {}),
      ...(p.multiple ? { multiple: true } : {}),
      ...(p.options && p.options.length > 0 && portTypeOf(data, p) === STRING_TYPE ? { options: p.options } : {}),
    })),
    ...outputs.map((p) => ({
      id: portHandleId('outputs', p.id),
      handleType: p.handleType,
      role: 'source' as const,
      label: p.label,
    })),
  ]
}

/**
 * The handles of a boundary inside the subgraph: on Inputs, a source per input
 * port that fans out, carrying the type the port has now and, for a port that
 * takes several, the types it takes; on Outputs, a target per output port
 * that takes one edge.
 */
export function boundaryHandles(data: unknown, side: PortSide): ExtensionHandle[] {
  return portsOf(data)[side].map((p) =>
    side === 'inputs'
      ? {
          id: portHandleId(side, p.id),
          handleType: portTypeOf(data, p),
          role: 'source' as const,
          label: p.label,
          ...(p.accepts && p.accepts.length > 0 ? { accepts: [...p.accepts] } : {}),
        }
      : { id: portHandleId(side, p.id), handleType: p.handleType, role: 'target' as const, label: p.label },
  )
}

const PORT_ID = /^[A-Za-z0-9_-]+$/

/**
 * Why `ports`, as a write gives a subgraph's `data.ports`, is not a list of
 * ports, or null when it is: `{ inputs, outputs }`, each port with an id of
 * letters, digits, `-` and `_` unique within the subgraph, a label and a
 * handle type.
 */
export function portsProblem(ports: unknown): string | null {
  if (typeof ports !== 'object' || ports === null || Array.isArray(ports)) {
    return 'data.ports must be { inputs: [...], outputs: [...] }'
  }
  const seen = new Set<string>()
  for (const side of ['inputs', 'outputs'] as const) {
    const list = (ports as Record<string, unknown>)[side]
    if (!Array.isArray(list)) {
      return `data.ports.${side} must be an array of ports`
    }
    for (const [i, port] of list.entries()) {
      const at = `data.ports.${side}[${i}]`
      const p = (typeof port === 'object' && port !== null ? port : {}) as Record<string, unknown>
      if (typeof p.id !== 'string' || !PORT_ID.test(p.id)) {
        return `${at}.id must be letters, digits, - and _: it makes the handle ids ${portHandleId(side, '<id>')}`
      }
      if (seen.has(p.id)) {
        return `${at}.id "${p.id}" is taken by another port of this subgraph`
      }
      seen.add(p.id)
      if (typeof p.label !== 'string') {
        return `${at}.label must be a string`
      }
      if (typeof p.handleType !== 'string' || p.handleType === '') {
        return `${at}.handleType must be the qualified handle type the port carries, e.g. "builtin.core.terminal-context"`
      }
      if (p.multiple !== undefined && (side === 'outputs' || typeof p.multiple !== 'boolean')) {
        return `${at}.multiple is a boolean, and only an input port has it`
      }
      const accepts = acceptsProblem(side, p.handleType, p.accepts)
      if (accepts) {
        return `${at}.accepts ${accepts}`
      }
      if (p.acceptsEnums !== undefined && (side === 'outputs' || typeof p.acceptsEnums !== 'boolean')) {
        return `${at}.acceptsEnums is a boolean, and only an input port has it`
      }
      if (p.options !== undefined) {
        const takesText = p.handleType === STRING_TYPE || (Array.isArray(p.accepts) && p.accepts.includes(STRING_TYPE))
        const problem = optionsProblem(side, takesText, p.options)
        if (problem) {
          return `${at}.options ${problem}`
        }
      }
    }
  }
  return null
}

// Why `accepts` are not the types a port takes, as a phrase following their name, or null.
function acceptsProblem(side: PortSide, handleType: unknown, accepts: unknown): string | null {
  if (accepts === undefined) {
    return null
  }
  if (side === 'outputs') {
    return 'are the types an input port takes: only an input port has them'
  }
  if (!Array.isArray(accepts) || accepts.length === 0 || !accepts.every((t) => isValueType(t))) {
    return `must be a list of value types: ${VALUE_TYPES.join(', ')}`
  }
  return accepts.includes(handleType) ? null : `must hold the port's handleType, ${String(handleType)}`
}

// Why `options` are not a port's choices, as a phrase following their name, or null.
function optionsProblem(side: PortSide, takesText: boolean, options: unknown): string | null {
  if (side === 'outputs' || !takesText) {
    return `are a text input port's choices: only an input port that takes "${STRING_TYPE}" has them`
  }
  if (!Array.isArray(options)) {
    return 'must be an array of { value, label? }'
  }
  const seen = new Set<string>()
  for (const option of options) {
    const o = (typeof option === 'object' && option !== null ? option : {}) as Record<string, unknown>
    if (typeof o.value !== 'string' || o.value === '') {
      return 'must each have a value, a non-empty string'
    }
    if (o.label !== undefined && typeof o.label !== 'string') {
      return `"${o.value}" has a label that is not a string`
    }
    if (seen.has(o.value)) {
      return `hold "${o.value}" twice: each choice is a value of its own`
    }
    seen.add(o.value)
  }
  return null
}

/**
 * `data` with the choices of its input port `portId` set to `options` (none
 * takes them away). A value typed on the card that is not one of them goes in
 * the same write, as the port would refuse it.
 */
export function withPortOptions(data: unknown, portId: string, options: readonly ValueOption[]): SubgraphData {
  const ports = portsOf(data)
  const inputs = ports.inputs.map((p) => {
    if (p.id !== portId) {
      return p
    }
    const { options: _options, ...port } = p
    return options.length > 0 ? { ...port, options: [...options] } : port
  })
  const next: SubgraphData = { ...(data as SubgraphData), ports: { ...ports, inputs } }
  const handleId = portHandleId('inputs', portId)
  const typed = typedValueOf(data as Record<string, unknown> | undefined, handleId)
  if (typed !== undefined && options.length > 0 && !options.some((o) => o.value === typed)) {
    const { [handleId]: _dropped, ...rest } = (data as { inputs: Record<string, unknown> }).inputs
    Object.assign(next, { inputs: rest })
  }
  return next
}

/** `label`, or `label 2`, `label 3`, … : the first not taken by the ports on `side`. */
export function freePortLabel(ports: readonly SubgraphPort[], label: string): string {
  const taken = new Set(ports.map((p) => p.label))
  if (!taken.has(label)) {
    return label
  }
  let n = 2
  while (taken.has(`${label} ${n}`)) {
    n++
  }
  return `${label} ${n}`
}
