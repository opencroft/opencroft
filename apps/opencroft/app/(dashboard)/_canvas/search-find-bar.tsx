'use client'

import { ArrowUp, type LucideIcon, Search, Target } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import type { CommandNodeEntry } from '@/app/(dashboard)/_canvas/canvas-command-bar'
import { CommandBarMenuItem } from '@/app/(dashboard)/_canvas/command-bar'
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context'

type SearchFindMode = 'search' | 'find'

interface MatchSnippet {
  path: string
  prefix: string
  highlight: string
  suffix: string
}

interface Result {
  key: string
  entry: CommandNodeEntry
  match?: MatchSnippet
}

const modeConfig: Record<SearchFindMode, { icon: LucideIcon; placeholder: string }> = {
  search: { icon: Search, placeholder: 'Search in nodes...' },
  find: { icon: Target, placeholder: 'Find node...' },
}

const MAX_RESULTS = 30
const CONTEXT_WINDOW = 30

function formatSnippet(path: string, value: string, start: number, end: number): MatchSnippet {
  const before = Math.max(0, start - CONTEXT_WINDOW)
  const after = Math.min(value.length, end + CONTEXT_WINDOW)
  return {
    path,
    prefix: (before > 0 ? '…' : '') + value.slice(before, start),
    highlight: value.slice(start, end),
    suffix: value.slice(end, after) + (after < value.length ? '…' : ''),
  }
}

function collectHits(data: unknown, query: string, out: MatchSnippet[], path = ''): void {
  if (out.length >= MAX_RESULTS) {
    return
  }
  if (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean') {
    const value = String(data)
    const idx = value.toLowerCase().indexOf(query)
    if (idx >= 0) {
      out.push(formatSnippet(path || '(root)', value, idx, idx + query.length))
    }
    return
  }
  if (Array.isArray(data)) {
    data.forEach((item, i) => collectHits(item, query, out, `${path}[${i}]`))
    return
  }
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const next = path ? `${path}.${key}` : key
      collectHits(value, query, out, next)
    }
  }
}

function computeResults(nodes: CommandNodeEntry[], mode: SearchFindMode, query: string): Result[] {
  const q = query.trim().toLowerCase()
  if (mode === 'find') {
    const source = !q ? nodes : nodes.filter((n) => `${n.label} ${n.subtitle}`.toLowerCase().includes(q))
    return source.slice(0, MAX_RESULTS).map((entry) => ({ key: entry.id, entry }))
  }
  if (mode === 'search') {
    if (!q) {
      return []
    }
    const out: Result[] = []
    for (const entry of nodes) {
      const hits: MatchSnippet[] = []
      collectHits(entry.data, q, hits)
      for (const hit of hits) {
        out.push({ key: `${entry.id}:${hit.path}`, entry, match: hit })
        if (out.length >= MAX_RESULTS) {
          return out
        }
      }
    }
    return out
  }
  return []
}

interface SearchFindBarProps {
  mode: SearchFindMode
  nodes: CommandNodeEntry[]
  focusTick: number
  onFocusNode: (nodeId: string) => void
  onFocusChange?: (focused: boolean) => void
  onReset: () => void
}

export function SearchFindBar({ mode, nodes, focusTick, onFocusNode, onFocusChange, onReset }: SearchFindBarProps) {
  const [text, setText] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setText('')
    setHighlight(0)
  }, [mode])

  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus()
    }
  }, [focusTick])

  useEffect(() => {
    setHighlight(0)
  }, [text])

  const results = useMemo(() => computeResults(nodes, mode, text), [nodes, mode, text])
  const config = modeConfig[mode]
  const Icon = config.icon

  const pickResult = (result: Result) => {
    onFocusNode(result.entry.id)
    inputRef.current?.blur()
    onReset()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const pick = results[highlight]
    if (pick) {
      pickResult(pick)
    }
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      inputRef.current?.blur()
      onReset()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      submit(event)
      return
    }
    if (results.length === 0) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((h) => Math.min(h + 1, results.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    }
  }

  const barNode = useMemo(
    () => (
      <>
        <Icon className='h-4 w-4 ml-1 mt-1.5 shrink-0 text-primary' />
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => {
            onFocusChange?.(false)
            onReset()
          }}
          onKeyDown={onInputKeyDown}
          placeholder={config.placeholder}
          className='border-0 shadow-none focus-visible:ring-0 focus-visible:border-0 bg-transparent h-8'
        />
        <Button type='button' size='icon' variant='ghost' className='h-7 w-7 shrink-0 mt-0.5' onMouseDown={(e) => e.preventDefault()} onClick={submit} disabled={results.length === 0}>
          <ArrowUp className='h-4 w-4' />
        </Button>
      </>
    ),
    [text, results.length, config.placeholder, Icon, onFocusChange, onReset],
  )

  const menuNode = useMemo(() => {
    if (results.length === 0) {
      return null
    }
    return results.map((result, i) => {
      const EntryIcon = result.entry.icon
      return (
        <CommandBarMenuItem key={result.key} active={i === highlight} onSelect={() => pickResult(result)} onHover={() => setHighlight(i)}>
          <div className='flex items-center gap-2 text-sm'>
            <EntryIcon className='h-4 w-4 shrink-0' style={{ color: result.entry.accent }} />
            <span className='truncate'>{result.entry.label}</span>
            <span className='ml-auto text-[10px] font-mono text-muted-foreground truncate'>{result.entry.subtitle}</span>
          </div>
          {result.match && (
            <div className='pl-6 font-mono text-[11px] leading-tight'>
              <span className='text-muted-foreground'>{result.match.path}: </span>
              <span className='text-muted-foreground'>{result.match.prefix}</span>
              <span className='bg-primary/30 text-foreground rounded-sm px-0.5'>{result.match.highlight}</span>
              <span className='text-muted-foreground'>{result.match.suffix}</span>
            </div>
          )}
        </CommandBarMenuItem>
      )
    })
  }, [results, highlight])

  useOverlayBar(barNode)
  useOverlayMenu(menuNode)

  return null
}
