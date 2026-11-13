'use client'

// The field `InputHandle` draws beside the pin of an input that takes a plain
// value (text, a number, true / false), so every extension's nodes get it by
// declaring the handle. Typed while nothing is wired, the value is stored at
// `data.inputs.<handle id>`. While an edge feeds the input there is no field
// at all, and the typed value stays stored for when the edge goes: what the
// input receives is in its pin's tooltip (`InputValueTip`). The field is the
// widget of the type the input has now, for one that takes several; an enum's
// is the dropdown of its cases, each shown by its label and stored as its
// value.

import {
  acceptedTypesPhrase,
  BOOLEAN_TYPE,
  NUMBER_TYPE,
  type PrimitiveValue,
  type ValueHandle,
} from '@opencroft/core/values'
import { useNodeId, useReactFlow } from '@xyflow/react'
import { createContext, useContext } from 'react'
import { NodeValueInput, type NodeValueKind } from 'ui/components/ui/nodes/node-value-input'

import { useValueInput, valueHandleOf } from '@/app/_authed/(dashboard)/_extension-system/use-node-context'

/**
 * Writes a value typed into a node's input: the canvas provides it, each write
 * one undo step. Without a canvas (a node drawn outside one) nothing is typed.
 */
export const TypedInputWriterContext = createContext<
  ((nodeId: string, handleId: string, value: PrimitiveValue) => void) | null
>(null)

function kindOf(handleType: string): NodeValueKind {
  if (handleType === NUMBER_TYPE) {
    return 'number'
  }
  return handleType === BOOLEAN_TYPE ? 'boolean' : 'text'
}

/**
 * The target handle `handleId` of the node being drawn as a value input, or
 * undefined when it takes no plain value. Decided from the node's handles,
 * read without subscribing: every input pin asks, and only a primitive one
 * should re-render with the graph. A node's type does not change while its
 * component is mounted (another type is another component), and a node whose
 * handles follow its data (a subgraph's ports, a value node's inputs)
 * re-renders its pins when its data changes, which reads the node again.
 */
export function useValueInputHandle(handleId: string): ValueHandle | undefined {
  const nodeId = useNodeId() ?? ''
  const { getNode } = useReactFlow()
  return valueHandleOf(getNode(nodeId), handleId)
}

/** The value field of the target handle `handleId` on the node being drawn; nothing for a handle that takes no plain value. */
export function InlineValue({ handleId }: { handleId: string }) {
  const nodeId = useNodeId() ?? ''
  return useValueInputHandle(handleId) ? <InlineValueField nodeId={nodeId} handleId={handleId} /> : null
}

/**
 * The tooltip of a value input's pin, drawn while it is open: the types the
 * input takes, and while an edge feeds it, the value it receives, since a
 * wired input shows no field.
 */
export function InputValueTip({ handleId }: { handleId: string }) {
  const nodeId = useNodeId() ?? ''
  const input = useValueInput(nodeId, handleId)
  if (!input) {
    return null
  }
  const takes = `Takes ${acceptedTypesPhrase(input.handle)}`
  if (!input.wired) {
    return takes
  }
  const received = input.value === undefined ? 'nothing' : shownValue(input.value)
  return (
    <>
      {takes}
      {'\n'}
      Receives <span className='font-mono tabular-nums'>{received}</span>
    </>
  )
}

function shownValue(value: PrimitiveValue): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

function InlineValueField({ nodeId, handleId }: { nodeId: string; handleId: string }) {
  const input = useValueInput(nodeId, handleId)
  const write = useContext(TypedInputWriterContext)
  if (!input || input.wired || input.handle.inline === false) {
    return null
  }
  const { handle, value } = input
  return (
    // A press in the field edits it; it does not drag the node or pan the canvas.
    <div className='nodrag nopan min-w-0 flex-1'>
      <NodeValueInput
        kind={kindOf(handle.handleType)}
        label={handle.label ?? handle.id}
        value={value}
        // Without a canvas nothing is typed: the value shows read-only.
        wired={!write}
        onCommit={(next) => write?.(nodeId, handleId, next)}
        integer={handle.integer}
        min={handle.min}
        max={handle.max}
        step={handle.step}
        options={handle.cases ? [...handle.cases] : handle.options}
        multiline={handle.multiline}
      />
    </div>
  )
}
