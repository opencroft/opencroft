'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AlertTriangle, Copy } from 'lucide-react'

import { Button } from 'ui/components/ui/button'
import { NodeCard, NodeCardContent, NodeCardHeader } from 'ui/components/ui/nodes/node-card'
import type { StatusVariant as IndicatorVariant } from 'ui/components/ui/utils/status-indicator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from 'ui/components/ui/tooltip'

// The frame's own status vocabulary, kept as it is because node authors already
// write against it. The map to the indicator's palette is presentation, so it
// belongs here rather than in the host.
export type NodeStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral'

const STATUS_MAP: Record<NodeStatus, IndicatorVariant | undefined> = {
  success: 'success',
  warning: 'warning',
  error: 'destructive',
  info: 'primary',
  neutral: undefined,
}

export interface NodeFrameProps {
  icon: LucideIcon
  title: string
  subtitle?: string
  status?: NodeStatus
  extra?: ReactNode
  selected: boolean
  loading?: boolean
  /** Failures for this node. Any entry turns the whole card destructive. */
  errors?: string[]
  /** Edge handle slots -- connection points are the canvas's, never the kit's. */
  input?: ReactNode
  output?: ReactNode
  children?: ReactNode
  /** Rendered inside the card, under the body. The canvas puts its stale-handle
   * row here: that row is derived from live graph state, so it cannot cross
   * into the kit -- but its position in the card can. */
  footer?: ReactNode
  /** The node type's accent colour. In the canvas this comes from a context the
   * host owns; here it is a value, so the component can be rendered anywhere. */
  accent?: string
  /** Notified after an error message has been copied, so the host can confirm
   * it however it confirms things. The copy itself happens here, so this never
   * gates the button -- a missing handler costs the toast, not the feature. */
  onCopyError?: (message: string) => void
}

function NodeErrorTooltip({
  errors,
  onCopyError,
  children,
}: {
  errors: string[]
  onCopyError?: (message: string) => void
  children: ReactNode
}) {
  const copy = (message: string) => {
    navigator.clipboard?.writeText(message)
    onCopyError?.(message)
  }

  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger render={<div />}>{children}</TooltipTrigger>
        {/* `nodrag nopan` are the canvas's own opt-out classes. They are inert
            anywhere else, and without them selecting the error text would drag
            the node instead. */}
        <TooltipContent
          side='top'
          className='nodrag nopan max-w-sm bg-destructive text-destructive-foreground p-2 pointer-events-auto select-text'
        >
          <div className='flex flex-col gap-1'>
            {errors.map((msg, i) => (
              <div key={i} className='flex items-start gap-2'>
                <span className='text-xs whitespace-pre-wrap break-words flex-1 font-mono'>{msg}</span>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-5 w-5 shrink-0 text-destructive-foreground hover:bg-destructive-foreground/20 hover:text-destructive-foreground'
                  onClick={() => copy(msg)}
                >
                  <Copy className='h-3 w-3' />
                </Button>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// A whole canvas node: the card, its header, an optional body and footer, and
// the error presentation over the top of all of it.
//
// What is NOT here is as deliberate as what is. The canvas keeps the accent
// context, the connection handles and the stale-handle detection, because each
// of those reads live graph state -- and a component that needs a graph to
// render cannot be shown in a preview, which is the whole point of it being
// here. They arrive as a prop and two slots instead.
export function NodeFrame({
  icon,
  title,
  subtitle,
  status,
  extra,
  selected,
  loading,
  errors,
  input,
  output,
  children,
  footer,
  accent = 'var(--muted-foreground)',
  onCopyError,
}: NodeFrameProps) {
  const hasErrors = !!errors && errors.length > 0
  const displayIcon = hasErrors ? AlertTriangle : icon
  const iconClassName = hasErrors ? 'text-destructive' : undefined
  const titleClassName = hasErrors ? 'text-destructive' : undefined

  const card = (
    <NodeCard selected={selected} loading={loading} accent={accent} error={hasErrors}>
      <NodeCardHeader
        icon={displayIcon}
        iconClassName={iconClassName}
        title={title}
        titleClassName={titleClassName}
        subtitle={subtitle}
        status={status ? STATUS_MAP[status] : undefined}
        extra={extra}
        input={input}
        output={output}
      />
      {children && <NodeCardContent>{children}</NodeCardContent>}
      {footer}
    </NodeCard>
  )

  if (!hasErrors) {
    return card
  }
  return (
    <NodeErrorTooltip errors={errors} onCopyError={onCopyError}>
      {card}
    </NodeErrorTooltip>
  )
}
