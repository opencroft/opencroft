import { Flex } from '@opencroft/client/ui'
import type { ReactNode } from 'react'

/**
 * A card's pins: its input rows down the left half and its output rows down
 * the right, both from the first row, so the first output sits beside the
 * first input. The outputs take the width they need (a Switch's case rows
 * carry their buttons) and the inputs the rest; a card with pins on one side
 * only gives that side the whole width.
 */
export function PinColumns({ inputs, outputs }: { inputs: readonly ReactNode[]; outputs: readonly ReactNode[] }) {
  if (inputs.length === 0 || outputs.length === 0) {
    return inputs.length + outputs.length > 0 ? <Flex className='gap-0.5'>{[...inputs, ...outputs]}</Flex> : null
  }
  return (
    <Flex row withGaps>
      <Flex className='min-w-0 flex-1 gap-0.5'>{inputs}</Flex>
      <Flex className='min-w-0 gap-0.5'>{outputs}</Flex>
    </Flex>
  )
}
