'use client'

import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import '@/app/(dashboard)/_canvas/node-card.css'
import { StatusIndicator, type StatusVariant } from '@opencroft/ui-kit/utils/status-indicator'
import { cn } from '@/lib/utils'

interface NodeCardProps {
  children: React.ReactNode
  selected?: boolean
  loading?: boolean
  accent?: string
  error?: boolean
  className?: string
}

function TravelingDot({ accent, dots = 8, dotSize = 4, className }: { accent: string; dots?: number; dotSize?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  useEffect(() => {
    if (!ref.current) {
      return
    }
    const obs = new ResizeObserver(([entry]) => {
      const rect = entry.target.getBoundingClientRect()
      setSize({ w: Math.round(rect.width), h: Math.round(rect.height) })
    })
    obs.observe(ref.current)
    return () => obs.disconnect()
  }, [])

  if (!size.w || !size.h) {
    return <div ref={ref} className='absolute inset-0 pointer-events-none' />
  }

  const r = 6

  return (
    <div ref={ref} className={cn('absolute inset-0 pointer-events-none overflow-visible', className)}>
      <svg width={size.w} height={size.h} className='overflow-visible'>
        {Array.from({ length: dots }, (_, i) => {
          const delay = -(i * (4 / dots))
          return (
            <rect
              key={i}
              x='0.5'
              y='0.5'
              width={size.w - 1}
              height={size.h - 1}
              rx={r}
              ry={r}
              fill='none'
              stroke={accent}
              strokeWidth='1'
              pathLength='100'
              strokeDasharray={`${dotSize} ${100 - dotSize}`}
              className='node-card-dot'
              style={{ animationDelay: `${delay}s` }}
            />
          )
        })}
      </svg>
    </div>
  )
}

export function NodeCard({ children, selected, loading, accent, error, className }: NodeCardProps) {
  const lineAccent = error ? 'var(--destructive)' : accent
  const showRing = error || ((loading || selected) && accent)
  const ringColor = error ? 'var(--destructive)' : accent ? `color-mix(in oklch, ${accent} 20%, transparent)` : undefined
  return (
    <div
      className={cn('relative min-w-[200px] rounded-md p-px', 'shadow-lg shadow-black/50 bg-card', selected ? 'brightness-100' : 'brightness-90', showRing && 'ring-1 ring-inset', className)}
      style={showRing && ringColor ? ({ '--tw-ring-color': ringColor } as React.CSSProperties) : undefined}
    >
      {lineAccent && (
        <>
          <div
            className={cn('absolute top-0 left-1 right-1 h-px', selected ? 'opacity' : 'opacity-50')}
            style={{ background: `linear-gradient(90deg, transparent 10%, ${lineAccent} 70%, transparent)` }}
          />
          <div
            className={cn('absolute bottom-0 left-1 right-1 h-px', selected ? 'opacity-50' : 'opacity-10')}
            style={{ background: `linear-gradient(90deg, transparent, ${lineAccent} 30%, transparent 90%)` }}
          />
        </>
      )}
      {loading && accent && !error && <TravelingDot accent={accent} className={'opacity-20'} />}
      {children}
    </div>
  )
}

interface NodeCardHeaderProps {
  icon: LucideIcon
  iconClassName?: string
  status?: StatusVariant
  title: string
  titleClassName?: string
  subtitle?: string
  extra?: React.ReactNode
  input?: React.ReactNode
  output?: React.ReactNode
  className?: string
}

export function NodeCardHeader({ icon: Icon, iconClassName, status, title, titleClassName, subtitle, extra, input, output, className }: NodeCardHeaderProps) {
  return (
    <div className={cn('flex items-center gap-2 px-4 py-2', className)}>
      {input}
      <div className='relative shrink-0'>
        <Icon className={cn('h-4 w-4', iconClassName)} />
        {status && <StatusIndicator variant={status} className='absolute -bottom-0.5 -right-0.5' />}
      </div>
      <div className='flex flex-col min-w-0'>
        <span className={cn('text font-medium truncate', titleClassName)}>{title}</span>
        {subtitle && <span className='text-[10px] font-mono text-muted-foreground truncate'>{subtitle}</span>}
      </div>
      <div className='flex-1 flex items-center min-w-0 justify-end'>{extra}</div>
      {output}
    </div>
  )
}

export function NodeCardContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('px-4 pb-3', className)}>
      <div className='h-px bg-gradient-to-r from-transparent via-white/[0.06] to-transparent mb-2' />
      {children}
    </div>
  )
}
