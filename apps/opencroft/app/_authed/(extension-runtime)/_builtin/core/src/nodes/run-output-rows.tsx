import { OutputHandle } from '@opencroft/client/canvas'

import { PinColumns } from './pin-columns'
import { RUN_OUTPUTS } from './run-outputs'
import { WHEN_IT_RUNS } from './value-nodes-shared'

/**
 * A producer's run-time output pins (see `RUN_OUTPUTS`), down the right of its
 * card. The canvas never has a run, so each pin's tooltip says when it has a
 * value rather than showing one.
 */
export function RunOutputRows({ type }: { type: keyof typeof RUN_OUTPUTS }) {
  const outputs = (RUN_OUTPUTS[type] ?? []).map((handle) => (
    <OutputHandle key={handle.id} type={handle.handleType} id={handle.id} tip={WHEN_IT_RUNS}>
      <span className='shrink-0 text-[10px] text-muted-foreground'>{handle.label ?? handle.id}</span>
    </OutputHandle>
  ))
  return <PinColumns inputs={[]} outputs={outputs} />
}
