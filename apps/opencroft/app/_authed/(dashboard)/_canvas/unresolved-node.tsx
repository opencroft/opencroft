'use client'

import { NodeLoadingPlaceholder } from 'ui/nodes/node-loading-placeholder'

interface UnresolvedNodeProps {
  /** The node type the graph asked for, which nothing has claimed. */
  type: string
  /** The node's own name. The graph carries it before its extension exists. */
  name?: string
  /** Whether extension loading has finished — successfully or not. */
  settled: boolean
}

/**
 * A node whose type no extension has claimed.
 *
 * Two states live here and they must not look alike. Still loading is transient
 * and needs nobody to do anything; genuinely missing is a fault someone has to
 * act on. A transient state wearing the fault's appearance is precisely how
 * people are taught to ignore the fault.
 *
 * Which state applies is decided by whether extension loading has FINISHED,
 * never by how long it has been going. Elapsed time would paint a healthy node
 * as broken on a slow connection, which is the failure this design exists to
 * avoid.
 */
export function UnresolvedNode({ type, name, settled }: UnresolvedNodeProps) {
  if (settled) {
    return (
      <div className='rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs'>
        Unknown extension: {type}
      </div>
    )
  }
  return (
    // The placeholder carries no size of its own by design — it fills the box
    // its host gives it, so it can never disagree with the node shell. This
    // canvas does not hand it one: a node element here has no width or height
    // and is sized by whatever it renders, so the box has to come from this
    // side. The bounds below are the ones a RESOLVED node is already drawn
    // within, not numbers chosen for this state — which is what keeps the two
    // the same width and stops a node jumping sideways as its extension lands.
    <div className='min-w-[200px] max-w-60'>
      {/* The type is the fallback name because it is the only other thing known
          about a node nothing has claimed, and an empty label would leave the
          placeholder announcing ", loading" to a screen reader. */}
      <NodeLoadingPlaceholder name={name ?? type} />
    </div>
  )
}
