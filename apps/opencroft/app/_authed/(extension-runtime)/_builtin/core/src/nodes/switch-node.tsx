import { NodeFrame, OutputHandle, useLiveNodeData, useUpdateNodeData } from '@opencroft/client/canvas'
import { Flex, inRowOrder, NodeRowList, NodeValueInput } from '@opencroft/client/ui'
import {
  awaitingRunOf,
  type PrimitiveValue,
  STRING_TYPE,
  type SwitchCase,
  switchCaseOutput,
  switchCasesOf,
  switchConditionType,
} from '@opencroft/client/values'
import { Split } from 'lucide-react'

import { PinColumns } from './pin-columns'
import { InputRow, loadedEnumCases, useHandlesFollowData } from './value-nodes'
import { newSwitchCaseId, VALUE_NODE, valueNodeHandles } from './value-nodes-shared'

type Data = Record<string, unknown>

/** `cases` with the case `id` changed to `value`, or null when that would leave it the same as another. */
function renamed(cases: readonly SwitchCase[], id: string, value: string): SwitchCase[] | null {
  if (cases.some((c) => c.id !== id && c.value === value)) {
    return null
  }
  return cases.map((c) => (c.id === id ? { ...c, value } : c))
}

// A Switch: its inputs on the left and its outputs on the right as rows,
// which follow the type connected into its condition (no picker: the type is
// set by connecting, see `switchConditionType`). On an enum, its cases' outputs
// are rows labelled as the enum labels them, then Default. On a text, each case is a row
// of the kit's Node Row List beside its output: dragged to another place, and
// renamed (never empty, nor the same as another) or deleted from its menu. An
// edge stays on its case through all of it, since a case's output is named by
// its id. A case removed leaves its edge as a stale pin.
export function SwitchNode({ id, data, selected }: { id: string; data: Data; selected?: boolean }) {
  const handles = valueNodeHandles(VALUE_NODE.switch, data, loadedEnumCases)
  useHandlesFollowData(id, handles)
  const awaited = awaitingRunOf(useLiveNodeData(id) ?? data)
  const update = useUpdateNodeData(id)
  const valueType = switchConditionType(data)
  const cases = switchCasesOf(data)
  const setCases = (next: SwitchCase[]) => update({ cases: next })
  const handleOf = new Map(handles.map((h) => [h.id, h]))
  const caseRows = cases.filter((c) => handleOf.has(switchCaseOutput(c.id)))
  const caseOutputs = new Set(caseRows.map((c) => switchCaseOutput(c.id)))
  const otherOutputs = handles.filter((h) => h.role === 'source' && !caseOutputs.has(h.id))

  return (
    <NodeFrame icon={Split} title='Switch' selected={selected ?? false}>
      <Flex withGaps className='min-w-48'>
        <PinColumns
          inputs={handles
            .filter((h) => h.role === 'target')
            .map((handle) => <InputRow key={handle.id} handle={handle} awaitsRun={awaited.includes(handle.id)} />)}
          outputs={[
            ...(caseRows.length > 0
              ? [
                  <NodeRowList
                    key='cases'
                    label='Cases'
                    rows={caseRows.map((c) => ({ id: c.id, label: c.value }))}
                    onReorder={(ids) => setCases(inRowOrder(cases, (c) => c.id, ids))}
                    onRename={(caseId, value) => {
                      const list = renamed(cases, caseId, value)
                      if (list) {
                        setCases(list)
                      }
                    }}
                    onDelete={(caseId) => setCases(cases.filter((c) => c.id !== caseId))}
                    wrapRow={(row, content) => {
                      const output = switchCaseOutput(row.id)
                      return (
                        <OutputHandle type={handleOf.get(output)?.handleType ?? ''} id={output}>
                          {content}
                        </OutputHandle>
                      )
                    }}
                  />,
                ]
              : []),
            ...otherOutputs.map((handle) => (
              <OutputHandle key={handle.id} type={handle.handleType} id={handle.id}>
                <span className='text-[10px] text-muted-foreground'>{handle.label ?? handle.id}</span>
              </OutputHandle>
            )),
          ]}
        />
        {valueType === STRING_TYPE ? (
          <div className='nodrag nopan min-w-0'>
            <NodeValueInput
              kind='text'
              label='New case'
              placeholder='Add a case…'
              value=''
              onCommit={(next: PrimitiveValue) => {
                const value = String(next)
                if (value !== '' && !cases.some((c) => c.value === value)) {
                  setCases([...cases, { id: newSwitchCaseId(cases), value }])
                }
              }}
            />
          </div>
        ) : null}
      </Flex>
    </NodeFrame>
  )
}
