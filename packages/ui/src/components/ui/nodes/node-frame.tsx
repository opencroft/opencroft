'use client'

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from 'cn'

import { NodeCard, NodeCardContent, NodeCardHeader } from 'ui/components/ui/nodes/node-card'
import type { StatusVariant as IndicatorVariant } from 'ui/components/ui/utils/status-indicator'

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
  /**
   * The node has errors. The card only shows that it has: the errors themselves
   * are read where there is room for them, in the node's inspector.
   */
  error?: boolean
  /**
   * Called when the error icon is pressed. Given, a node in error draws its
   * icon as a button that opens the errors. The press stops at the button, so
   * the card's own click handling does not run as well.
   */
  onShowErrors?: () => void
  /** Classes for that button. The canvas passes the ones that keep its drag
   * and pan gestures from starting on it. */
  showErrorsClassName?: string
  /** Edge handle slots -- connection points are the canvas's, never the kit's. */
  input?: ReactNode
  output?: ReactNode
  /** The header's drag area: see `NodeCardHeader`. */
  dragArea?: ReactNode
  children?: ReactNode
  /** Rendered inside the card, under the body. The canvas puts its stale-handle
   * row here: that row is derived from live graph state, so it cannot cross
   * into the kit -- but its position in the card can. */
  footer?: ReactNode
  /** The node type's accent colour. In the canvas this comes from a context the
   * host owns; here it is a value, so the component can be rendered anywhere. */
  accent?: string
}

// A whole canvas node: the card, its header, an optional body and footer, and
// whether it is in error.
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
  error = false,
  onShowErrors,
  showErrorsClassName,
  input,
  output,
  dragArea,
  children,
  footer,
  accent = 'var(--muted-foreground)',
}: NodeFrameProps) {
  return (
    <NodeCard selected={selected} loading={loading} accent={accent} error={error}>
      <NodeCardHeader
        icon={error ? <ErrorIcon onShowErrors={onShowErrors} className={showErrorsClassName} /> : icon}
        title={title}
        titleClassName={error ? 'text-destructive' : undefined}
        subtitle={subtitle}
        status={status ? STATUS_MAP[status] : undefined}
        extra={extra}
        input={input}
        output={output}
        dragArea={dragArea}
      />
      {children && <NodeCardContent>{children}</NodeCardContent>}
      {footer}
    </NodeCard>
  )
}

function ErrorIcon({ onShowErrors, className }: { onShowErrors?: () => void; className?: string }) {
  const icon = <AlertTriangle className='h-4 w-4 text-destructive' />
  if (!onShowErrors) {
    return icon
  }
  return (
    <button
      type='button'
      aria-label='Show errors'
      className={cn(
        'flex cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation()
        onShowErrors()
      }}
    >
      {icon}
    </button>
  )
}
