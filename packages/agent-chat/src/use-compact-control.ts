'use client'

// Compacting a session -- shrinking its context window without losing its
// instructions -- is a base ACP-session capability, not something specific to
// any one host. This is the compact-specific instantiation of
// useAsyncActionStatus: what counts as busy, and what a finished status says.
//
// The request/fetch calls are always host-specific (which endpoint, what
// transport a given host's sessions are reached through) and are always
// supplied by the caller -- the extension-point convention this package
// already follows for composer-bar host slots and session<->agent binding.
import { useMemo } from 'react'

import { useAsyncActionStatus } from './use-async-action-status'

export interface CompactContextUsage {
  usedTokens: number
  contextLimit: number | null
}

export interface CompactResult {
  contextUsageBefore: CompactContextUsage | null
  contextUsageAfter: CompactContextUsage | null
  compacted: boolean | null
}

export interface CompactStatus {
  state: 'never-requested' | 'pending' | 'running' | 'done' | 'error'
  result?: CompactResult
  error?: string
}

export interface CompactRenderState {
  onCompact: () => void
  compacting: boolean
  statusMessage?: string
  statusTone: 'default' | 'destructive'
}

function isCompactBusy(status: CompactStatus | null): boolean {
  return status?.state === 'pending' || status?.state === 'running'
}

function formatCount(n: number): string {
  return n.toLocaleString()
}

// The default outcome formatter -- generic prose about token compaction, not
// any one host's wording. A host that needs different copy can call
// useAsyncActionStatus directly with its own `describe` instead of this hook.
export function compactStatusMessage(status: CompactStatus | null): {
  message?: string
  tone: 'default' | 'destructive'
} {
  if (!status || status.state === 'never-requested' || status.state === 'pending' || status.state === 'running') {
    return { tone: 'default' }
  }
  if (status.state === 'error') {
    return { message: status.error ?? 'Compaction failed.', tone: 'destructive' }
  }
  // 'done'
  const result = status.result
  if (!result) {
    return { message: 'Compaction finished.', tone: 'default' }
  }
  if (result.compacted === false) {
    return { message: 'Nothing to compact — this session was already small.', tone: 'default' }
  }
  const before = result.contextUsageBefore?.usedTokens
  const after = result.contextUsageAfter?.usedTokens
  if (result.compacted && typeof before === 'number' && typeof after === 'number') {
    return { message: `Compacted — ${formatCount(before)} → ${formatCount(after)} tokens.`, tone: 'default' }
  }
  return { message: 'Compacted.', tone: 'default' }
}

export function useCompactControl(
  key: string,
  fetchStatus: (key: string) => Promise<CompactStatus>,
  requestCompact: (key: string) => Promise<{ ok: true } | { ok: false; message: string }>,
): CompactRenderState {
  const { trigger, busy, message, tone } = useAsyncActionStatus(
    key,
    fetchStatus,
    requestCompact,
    isCompactBusy,
    compactStatusMessage,
  )
  // useAsyncActionStatus already returns an identity-stable object; this is
  // just a field rename, but re-wrapping in a fresh literal every render
  // would throw that stability away again one layer up -- memoize the rename
  // too, on the same primitives.
  return useMemo(
    () => ({ onCompact: trigger, compacting: busy, statusMessage: message, statusTone: tone }),
    [trigger, busy, message, tone],
  )
}
