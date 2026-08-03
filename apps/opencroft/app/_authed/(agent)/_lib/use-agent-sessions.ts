'use client'

import { useCallback, useEffect, useState } from 'react'

import { useChatTabsMaybe } from '@/app/_authed/(agent)/_lib/chat-tabs-context'
import { forgetLocalSession } from '@/app/_authed/(agent)/_server/acp'
import type { SessionEntry } from '@/app/_authed/(agent)/_server/agent-sessions-store'

const SESSIONS_ENDPOINT = '/api/acp/sessions'
const JSON_HEADERS = { 'content-type': 'application/json' }
// Sessions that only ever lived in this browser's localStorage, lifted into the
// shared DB once so pre-existing chats aren't lost when we switch stores.
const LEGACY_SESSIONS_KEY = 'opencroft.aiPanel.sessions'

function fetchSessions(): Promise<SessionEntry[]> {
  return fetch(SESSIONS_ENDPOINT)
    .then((r) => r.json())
    .then((list) => (Array.isArray(list) ? list : []))
}

function upsertSessionRemote(entry: Partial<SessionEntry> & { key: string }): Promise<SessionEntry[]> {
  return fetch(SESSIONS_ENDPOINT, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ op: 'upsert', entry }),
  }).then((r) => r.json() as Promise<SessionEntry[]>)
}

function deleteSessionRemote(key: string): Promise<SessionEntry[]> {
  return fetch(SESSIONS_ENDPOINT, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ op: 'delete', key }),
  }).then((r) => r.json() as Promise<SessionEntry[]>)
}

function readLegacySessions(): SessionEntry[] {
  if (typeof window === 'undefined') {
    return []
  }
  const raw = window.localStorage.getItem(LEGACY_SESSIONS_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export interface UseAgentSessionsResult {
  sessions: SessionEntry[]
  upsertSession: (entry: SessionEntry) => void
  renameSession: (key: string, title: string) => void
  // Save (or clear, with an empty string) this session's composer draft. Unlike
  // `upsertSession` (which replaces its local entry wholesale — callers always
  // have the full entry in hand when creating one), this does a proper partial
  // merge locally, matching what the server-side store already does.
  setDraft: (key: string, draft: string) => void
  // Full cleanup: closes the tab (if open), drops the local ACP session, and
  // removes the registry entry. Use this — not a raw store call — anywhere a
  // session needs to actually go away (sidebar Delete, canvas session list).
  deleteSession: (key: string) => void
}

// The shared chat-session registry (agent/job binding, title), synced live
// across devices via SSE. Both the canvas session list and the sidebar chat
// list read/write through this single hook so they never drift out of sync.
// Each mount opens its own EventSource + re-runs the legacy-localStorage lift
// (idempotent — upserts are by key, so a race just re-sends the same data) —
// harmless today at two call sites, but a shared subscription is the fix if a
// third ever gets added.
export function useAgentSessions(): UseAgentSessionsResult {
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const chatTabs = useChatTabsMaybe()

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null
    const start = async () => {
      const legacy = readLegacySessions()
      if (legacy.length) {
        const current = await fetchSessions().catch(() => [] as SessionEntry[])
        for (const entry of legacy) {
          if (!current.some((s) => s.key === entry.key)) {
            await upsertSessionRemote(entry).catch(() => {})
          }
        }
        window.localStorage.removeItem(LEGACY_SESSIONS_KEY)
      }
      if (cancelled) {
        return
      }
      source = new EventSource('/api/acp/sessions-stream')
      source.onmessage = (e) => {
        try {
          const list = JSON.parse(e.data) as SessionEntry[]
          if (!cancelled) {
            setSessions(Array.isArray(list) ? list : [])
          }
        } catch {}
      }
    }
    void start()
    return () => {
      cancelled = true
      source?.close()
    }
  }, [])

  const upsertSession = useCallback((entry: SessionEntry) => {
    setSessions((prev) => [...prev.filter((s) => s.key !== entry.key), entry])
    upsertSessionRemote(entry)
      .then((list) => setSessions(list))
      .catch((err) => console.error('Failed to save session', entry.key, err))
  }, [])

  const renameSession = useCallback(
    (key: string, title: string) => {
      const trimmed = title.trim()
      if (!trimmed) {
        return
      }
      setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, title: trimmed } : s)))
      upsertSessionRemote({ key, title: trimmed })
        .then((list) => setSessions(list))
        .catch((err) => console.error('Failed to rename session', key, err))
      chatTabs?.updateTabMeta(key, { label: trimmed })
    },
    [chatTabs],
  )

  // Unlike upsertSession/renameSession, deliberately doesn't re-sync `sessions`
  // from the POST response: this fires on every debounced keystroke while
  // typing, and the optimistic update above is already correct — chaining a
  // second setSessions per tick would needlessly re-run the sidebar's tree
  // reconcile more than the SSE broadcast alone already does.
  const setDraft = useCallback((key: string, draft: string) => {
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, draft } : s)))
    upsertSessionRemote({ key, draft }).catch((err) => console.error('Failed to save draft', key, err))
  }, [])

  const deleteSession = useCallback(
    (key: string) => {
      chatTabs?.closeTab(key)
      setSessions((prev) => prev.filter((s) => s.key !== key))
      deleteSessionRemote(key)
        .then((list) => setSessions(list))
        .catch((err) => console.error('Failed to delete session', key, err))
      forgetLocalSession({ data: key }).catch((err) => {
        console.error('Failed to forget local session', key, err)
      })
    },
    [chatTabs],
  )

  return { sessions, upsertSession, renameSession, setDraft, deleteSession }
}
