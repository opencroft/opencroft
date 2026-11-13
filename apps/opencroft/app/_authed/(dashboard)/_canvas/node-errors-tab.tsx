'use client'

import type { NodeErrorEntry } from '@opencroft/core'
import { createContext, useContext } from 'react'
import { toast } from 'sonner'
import { NodeErrors } from 'ui/nodes/node-errors'

/** The inspector tab id of a node's errors, for a surface that opens it (`inspectorIntent.open`). */
export const NODE_ERRORS_TAB = 'errors'

/**
 * The inspected node's errors, as the inspector read them to decide whether
 * the tab is shown: the tab renders that same list.
 */
export const InspectedNodeErrors = createContext<NodeErrorEntry[]>([])

/** The inspected node's Errors tab: every error its card's indicator stands for. */
export function NodeErrorsTab() {
  const errors = useContext(InspectedNodeErrors)
  return <NodeErrors errors={errors} onCopy={() => toast.success('Copied error to clipboard')} />
}
