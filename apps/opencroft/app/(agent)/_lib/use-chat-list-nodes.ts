'use client'

import type { ChatListNode } from 'ui/chat/chat-list'
import { useEffect, useMemo, useState } from 'react'

import type { SessionEntry } from '@/app/(agent)/_server/agent-sessions-store'
import type { ChatListLayout, ChatListLayoutEntry } from '@/app/(agent)/_server/chat-list-layout-store'
import { deriveSessionStatus } from '@/app/(agent)/_shared/session-status'
import { listAgentNodes } from '@/app/(space)/_server/agents'

const LAYOUT_ENDPOINT = '/api/acp/chat-list-layout'
const JSON_HEADERS = { 'content-type': 'application/json' }
const EMPTY_LAYOUT: ChatListLayout = { entries: [], hiddenKeys: [] }

function fetchLayout(): Promise<ChatListLayout> {
  return fetch(LAYOUT_ENDPOINT)
    .then((r) => r.json())
    .then((data: Partial<ChatListLayout>) => ({
      entries: Array.isArray(data.entries) ? data.entries : [],
      hiddenKeys: Array.isArray(data.hiddenKeys) ? data.hiddenKeys : [],
    }))
    .catch(() => EMPTY_LAYOUT)
}

function saveLayout(layout: ChatListLayout): void {
  fetch(LAYOUT_ENDPOINT, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(layout),
  }).catch((err) => console.error('Failed to save chat list layout', err))
}

export function toLeaf(
  session: SessionEntry,
  pendingKeys: Set<string>,
  activeKeys: Set<string>,
  aliveKeys: Set<string>,
  avatarByAgentId: Map<string, string>,
) {
  return {
    id: session.key,
    title: session.title ?? session.jobName,
    description: session.agentName,
    avatarUrl: avatarByAgentId.get(session.agentNodeId),
    status: deriveSessionStatus(session.key, { pending: pendingKeys, active: activeKeys, alive: aliveKeys }),
    hasDraft: Boolean(session.draft?.trim()),
  }
}

// Rehydrate the persisted skeleton (ids, folder names/order) against the live
// session list — session titles/descriptions always come from `sessions`, never
// the layout, so a rename elsewhere shows up without a separate layout write.
// A session missing from the layout (new, or created on another device) is
// appended at the top level; a layout entry whose session no longer exists is
// dropped (the next onChange persists the cleaned-up layout). `hiddenKeys`
// sessions (closed from the list, not deleted — see chat-list-layout-store.ts)
// are filtered out up front, so hiding one drops it everywhere it could
// appear — loose or foldered — without touching the folder-building logic.
function buildNodes(
  entries: ChatListLayoutEntry[],
  allSessions: SessionEntry[],
  hiddenKeys: Set<string>,
  pendingKeys: Set<string>,
  activeKeys: Set<string>,
  aliveKeys: Set<string>,
  avatarByAgentId: Map<string, string>,
): ChatListNode[] {
  const sessions = allSessions.filter((s) => !hiddenKeys.has(s.key))
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const nodes: ChatListNode[] = []
  for (const entry of entries) {
    if (entry.kind === 'item') {
      const session = byKey.get(entry.key)
      if (!session) {
        continue
      }
      seen.add(entry.key)
      nodes.push({ type: 'item', item: toLeaf(session, pendingKeys, activeKeys, aliveKeys, avatarByAgentId) })
    } else {
      const items = entry.folder.itemKeys.map((key) => byKey.get(key)).filter((s): s is SessionEntry => Boolean(s))
      for (const session of items) {
        seen.add(session.key)
      }
      nodes.push({
        type: 'folder',
        folder: {
          id: entry.folder.id,
          name: entry.folder.name,
          open: entry.folder.open,
          items: items.map((s) => toLeaf(s, pendingKeys, activeKeys, aliveKeys, avatarByAgentId)),
        },
      })
    }
  }
  for (const session of sessions) {
    if (!seen.has(session.key)) {
      nodes.push({ type: 'item', item: toLeaf(session, pendingKeys, activeKeys, aliveKeys, avatarByAgentId) })
    }
  }
  return nodes
}

function toEntries(nodes: ChatListNode[]): ChatListLayoutEntry[] {
  return nodes.map((n) =>
    n.type === 'item'
      ? { kind: 'item', key: n.item.id }
      : { kind: 'folder', folder: { id: n.folder.id, name: n.folder.name, open: n.folder.open, itemKeys: n.folder.items.map((i) => i.id) } },
  )
}

export interface UseChatListNodesResult {
  nodes: ChatListNode[]
  // ChatList seeds its working tree from `nodes` once (on mount) and never
  // resyncs — a controlled component would need a design-kit change. So this
  // key forces a remount only when an EXTERNAL input a row displays (or
  // whether it displays at all) changes — a session title, membership,
  // hidden state, or status dot — never on a local order/folder edit. A local
  // edit already lives in the component's own state and is persisted through
  // onChange, so remounting on it would only discard in-flight interaction:
  // fatally for "Move to new folder", whose post-commit inline rename would
  // be reset by the remount before the user can type. Trade-off that remains:
  // an external change still remounts mid-interaction, dropping an
  // in-progress drag or open menu — acceptable until ChatList is made controlled.
  nodesKey: string
  onChange: (nodes: ChatListNode[]) => void
  // Close = remove from the sidebar list without deleting the session (see
  // closeSession below) — persisted alongside the layout.
  closeSession: (key: string) => void
}

// Combines the persisted layout (order + folders + hidden/closed sessions)
// with the live session list into the node tree ChatList renders, and
// persists whatever the component reports back via onChange. `activeSessionKey`
// is ChatTabsProvider's single source of truth for "which session is on
// screen" — every path that activates one (sidebar click, canvas session
// picker, a deep link's `?chat=` param) funnels through it, so watching it
// here is the one place that un-hides a closed session on reactivation
// (a picker click, a deep link, and so on).
export function useChatListNodes(
  sessions: SessionEntry[],
  pendingKeys: Set<string>,
  activeKeys: Set<string>,
  aliveKeys: Set<string>,
  activeSessionKey: string,
): UseChatListNodesResult {
  const [entries, setEntries] = useState<ChatListLayoutEntry[]>([])
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [loaded, setLoaded] = useState(false)
  const [avatarByAgentId, setAvatarByAgentId] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    fetchLayout().then((layout) => {
      if (!cancelled) {
        setEntries(layout.entries)
        setHiddenKeys(new Set(layout.hiddenKeys))
        setLoaded(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    // Same source AiPanel uses to stamp `agentAvatar` onto open tabs — read
    // directly here instead, since sidebar rows have no tab meta to borrow
    // from (most have no open tab at all). A failed fetch just leaves rows on
    // their initials fallback (ChatListItem's default), so no catch-driven
    // state flip is needed the way the layout fetch needs one.
    listAgentNodes()
      .then((agents) => {
        if (!cancelled) {
          setAvatarByAgentId(new Map(agents.filter((a) => a.avatar).map((a) => [a.nodeId, a.avatar as string])))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const nodes = useMemo(
    () => (loaded ? buildNodes(entries, sessions, hiddenKeys, pendingKeys, activeKeys, aliveKeys, avatarByAgentId) : []),
    [loaded, entries, sessions, hiddenKeys, pendingKeys, activeKeys, aliveKeys, avatarByAgentId],
  )
  // Key on external inputs only (see UseChatListNodesResult.nodesKey): each
  // session's identity, display text, avatar, hidden state, and status dot —
  // deliberately NOT the layout order/folders the component owns after
  // mount. Sorted by key so a reordered session fetch alone doesn't trigger a
  // spurious remount. `loaded` is folded in so the initial false->true flip
  // remounts once with the real tree: sessions can arrive (via SSE) before
  // the layout GET returns, which seeds an empty `nodes`, and without this
  // the list would stay empty until the next external change. Avatars
  // resolve async too (their own fetch), so including them lets that arrival
  // trigger its own one-time remount instead of leaving rows stuck on initials.
  const nodesKey = useMemo(
    () =>
      `${loaded}:${JSON.stringify(
        sessions
          .filter((s) => !hiddenKeys.has(s.key))
          .map((s) => ({
            id: s.key,
            title: s.title ?? s.jobName,
            agent: s.agentName,
            avatar: avatarByAgentId.get(s.agentNodeId),
            pending: pendingKeys.has(s.key),
            active: activeKeys.has(s.key),
            alive: aliveKeys.has(s.key),
            hasDraft: Boolean(s.draft?.trim()),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      )}`,
    [loaded, sessions, hiddenKeys, pendingKeys, activeKeys, aliveKeys, avatarByAgentId],
  )

  const onChange = (next: ChatListNode[]) => {
    const nextEntries = toEntries(next)
    setEntries(nextEntries)
    saveLayout({ entries: nextEntries, hiddenKeys: [...hiddenKeys] })
  }

  const closeSession = (key: string) => {
    if (hiddenKeys.has(key)) {
      return
    }
    const next = new Set(hiddenKeys)
    next.add(key)
    setHiddenKeys(next)
    saveLayout({ entries, hiddenKeys: [...next] })
  }

  // A closed session that becomes the active one again (canvas picker, a
  // deep link) must come back — otherwise its row stays hidden while it's
  // the one conversation on screen, and later replies land somewhere the
  // user can never see. `loaded` guards this against firing before the
  // fetched hiddenKeys arrive.
  useEffect(() => {
    if (!loaded || !hiddenKeys.has(activeSessionKey)) {
      return
    }
    const next = new Set(hiddenKeys)
    next.delete(activeSessionKey)
    setHiddenKeys(next)
    saveLayout({ entries, hiddenKeys: [...next] })
  }, [loaded, activeSessionKey, hiddenKeys, entries])

  return { nodes, nodesKey, onChange, closeSession }
}
