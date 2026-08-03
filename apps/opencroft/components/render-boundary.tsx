'use client'

import { AlertTriangle } from 'lucide-react'
import { Component, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface RenderBoundaryProps {
  /** Prefix for the console log, e.g. `ext` or `tool-view`. */
  scope: string
  /** Names the thing that failed, both in the log and on screen. */
  label: string
  /** When this changes, a previous failure is cleared and the child retried. */
  resetKey?: string
  className?: string
  children: ReactNode
}

interface RenderBoundaryState {
  error: Error | null
}

/**
 * Contains a render failure to the subtree that caused it.
 *
 * React unmounts the whole tree up to the nearest boundary, so without one a
 * single bad component takes down the entire route. Where the failing content
 * comes from persisted history — a message in a chat transcript, say — that is
 * not a transient error but a permanent one: the same content re-renders and
 * re-throws on every visit, and the page can never be opened again.
 *
 * Rendering the failure in place instead keeps the damage to one block.
 */
export class RenderBoundary extends Component<RenderBoundaryProps, RenderBoundaryState> {
  state: RenderBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): RenderBoundaryState {
    return { error }
  }

  componentDidUpdate(prevProps: RenderBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null })
    }
  }

  componentDidCatch(error: Error): void {
    console.error(`[${this.props.scope}:${this.props.label}] render failed`, error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) {
      return this.props.children
    }
    return (
      <div
        className={cn(
          'rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs',
          this.props.className,
        )}
      >
        <div className='flex items-center gap-1 font-semibold'>
          <AlertTriangle className='size-3' />
          {this.props.label}
        </div>
        <div className='mt-1 font-mono text-[10px] truncate' title={error.message}>
          {error.message}
        </div>
      </div>
    )
  }
}
