import { invoke } from '@opencroft/client/actions'
import { NodeFrame, OutputHandle, useLiveNodeData, useUpdateNodeData } from '@opencroft/client/canvas'
import { type CallActionActionOption, CallActionTarget, type CallActionTargetValue, Flex } from '@opencroft/client/ui'
import { awaitingRunOf } from '@opencroft/client/values'
import type { GraphCallAction, GraphCallTargets } from '@opencroft/server/terminal'
import { Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  type CallActionParam,
  callActionHandles,
  callActionIdOf,
  callActionParamsOf,
  callActionTargetOf,
  paramsOfSchema,
  sameParams,
} from './call-action-shared'
import { PinColumns } from './pin-columns'
import { InputRow, useHandlesFollowData } from './value-nodes'
import { WHEN_IT_RUNS } from './value-nodes-shared'

type Data = Record<string, unknown>

const NO_TARGETS: GraphCallTargets = { nodes: [], apps: [] }

/** Why a graph may not call `action`, or undefined when it may. */
function unavailableOf(action: GraphCallAction): string | undefined {
  if (action.admin) {
    return 'Its extension declares it for administrators only.'
  }
  const params = paramsOfSchema(action.inputSchema)
  return params.ok ? undefined : params.unavailable
}

/** The parameter snapshot `action` gives, or none when a graph may not call it. */
function paramsOfAction(action: GraphCallAction | undefined): CallActionParam[] {
  const params = action ? paramsOfSchema(action.inputSchema) : undefined
  return params?.ok ? params.params : []
}

/** What the card offers to call from this node's graph, asked once when the card mounts. */
function useCallTargets(nodeId: string): GraphCallTargets | null {
  const [targets, setTargets] = useState<GraphCallTargets | null>(null)
  useEffect(() => {
    let live = true
    invoke<GraphCallTargets>('callAction.targets', nodeId)
      .then((listed) => live && setTargets(listed))
      .catch((err: unknown) => {
        console.error('[call-action] could not list targets', err)
        if (live) {
          setTargets(NO_TARGETS)
        }
      })
    return () => {
      live = false
    }
  }, [nodeId])
  return targets
}

/** The actions `target` offers, asked again whenever the target changes; empty without one. */
function useTargetActions(nodeId: string, target: CallActionTargetValue | undefined): GraphCallAction[] {
  const key = target ? JSON.stringify(target) : ''
  const [actions, setActions] = useState<{ key: string; actions: GraphCallAction[] }>({ key: '', actions: [] })
  useEffect(() => {
    if (!key) {
      return
    }
    let live = true
    invoke<GraphCallAction[]>('callAction.actions', nodeId, JSON.parse(key))
      .then((listed) => live && setActions({ key, actions: listed }))
      .catch((err: unknown) => {
        // The node's check says why the target does not resolve.
        console.error('[call-action] could not list actions', err)
        if (live) {
          setActions({ key, actions: [] })
        }
      })
    return () => {
      live = false
    }
  }, [nodeId, key])
  return actions.key === key ? actions.actions : []
}

// A Call Action: what it calls (the kit's Call Action Target), then its inputs
// on the left (Run and one per parameter of the action, each with its typed
// value beside it while nothing is wired); on the right Done and Failed, then
// the outcome outputs, whose tooltips say When it runs: the canvas never has a
// run.
// Picking an action takes the snapshot of its parameters; picking another
// target keeps the action only while the new target's type is the same.
export function CallActionNode({ id, data, selected }: { id: string; data: Data; selected?: boolean }) {
  const handles = callActionHandles(data)
  useHandlesFollowData(id, handles)
  const awaited = awaitingRunOf(useLiveNodeData(id) ?? data)
  const update = useUpdateNodeData(id)
  const targets = useCallTargets(id)
  const target = callActionTargetOf(data)
  const actionId = callActionIdOf(data)
  const actions = useTargetActions(id, target)
  const picked = actions.find((a) => a.id === actionId)
  const stale =
    picked !== undefined && unavailableOf(picked) === undefined
      ? !sameParams(callActionParamsOf(data), paramsOfAction(picked))
      : false

  const options = useMemo<CallActionActionOption[]>(
    () => actions.map((a) => ({ id: a.id, label: a.label, unavailable: unavailableOf(a) })),
    [actions],
  )
  const typeOf = (value: CallActionTargetValue | undefined) => {
    if (!value) {
      return undefined
    }
    return 'app' in value ? `app:${value.app}` : targets?.nodes.find((n) => n.id === value.nodes[0])?.type
  }

  const handleTargetChange = (next: CallActionTargetValue | undefined) => {
    const sameKind = typeOf(next) !== undefined && typeOf(next) === typeOf(target)
    update(sameKind ? { target: next } : { target: next ?? null, action: '', params: [] })
  }

  return (
    <NodeFrame icon={Zap} title='Call Action' selected={selected ?? false}>
      <Flex withGaps className='min-w-56'>
        <div className='nodrag nopan min-w-0'>
          <CallActionTarget
            nodes={(targets ?? NO_TARGETS).nodes.map((n) => ({
              id: n.id,
              name: n.name,
              type: n.type,
              typeName: n.typeName,
              path: n.path,
            }))}
            apps={(targets ?? NO_TARGETS).apps.map((a) => ({ id: a.instanceId, address: a.address, name: a.name }))}
            value={target}
            onValueChange={handleTargetChange}
            actions={options}
            action={actionId}
            onActionChange={(next) =>
              update({ action: next, params: paramsOfAction(actions.find((a) => a.id === next)) })
            }
            stale={stale}
            onRefresh={() => update({ params: paramsOfAction(picked) })}
            disabled={targets === null}
          />
        </div>
        <PinColumns
          inputs={handles
            .filter((h) => h.role === 'target')
            .map((handle) => <InputRow key={handle.id} handle={handle} awaitsRun={awaited.includes(handle.id)} />)}
          outputs={handles
            .filter((h) => h.role === 'source')
            .map((handle) => (
              <OutputHandle
                key={handle.id}
                type={handle.handleType}
                id={handle.id}
                tip={handle.runtime ? WHEN_IT_RUNS : undefined}
              >
                <span className='text-[10px] text-muted-foreground'>{handle.label ?? handle.id}</span>
              </OutputHandle>
            ))}
        />
      </Flex>
    </NodeFrame>
  )
}
