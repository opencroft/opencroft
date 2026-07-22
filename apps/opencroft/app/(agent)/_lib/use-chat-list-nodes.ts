'use client'

import type { ChatListNode } from 'ui/chat/chat-list'
import { useEffect, useMemo, useState } from 'react'

import type { SessionEntry } from '@/app/(agent)/_server/agent-sessions-store'
import type { ChatListLayoutEntry } from '@/app/(agent)/_server/chat-list-layout-store'
import { listAgentNodes } from '@/app/(space)/_server/agents'

const LAYOUT_ENDPOINT = '/api/acp/chat-list-layout'
const JSON_HEADERS = { 'content-type': 'application/json' }

function fetchLayout(): Promise<ChatListLayoutEntry[]> {
  return fetch(LAYOUT_ENDPOINT)
    .then((r) => r.json())
    .then((list) => (Array.isArray(list) ? list : []))
}

function saveLayout(entries: ChatListLayoutEntry[]): void {
  fetch(LAYOUT_ENDPOINT, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ entries }),
  }).catch((err) => console.error('Failed to save chat list layout', err))
}

function toLeaf(session: SessionEntry, pendingKeys: Set<string>, avatarByAgentId: Map<string, string>) {
  return {
    id: session.key,
    title: session.title ?? session.jobName,
    description: session.agentName,
    avatarUrl: avatarByAgentId.get(session.agentNodeId),
    statusIndicator: pendingKeys.has(session.key) ? ('primary' as const) : undefined,
  }
}

// Rehydrate the persisted skeleton (ids, folder names/order) against the live
// session list — session titles/descriptions always come from `sessions`, never
// the layout, so a rename elsewhere shows up without a separate layout write.
// A session missing from the layout (new, or created on another device) is
// appended at the top level; a layout entry whose session no longer exists is
// dropped (the next onChange persists the cleaned-up layout).
function buildNodes(
  layout: ChatListLayoutEntry[],
  sessions: SessionEntry[],
  pendingKeys: Set<string>,
  avatarByAgentId: Map<string, string>,
): ChatListNode[] {
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const seen = new Set<string>()
  const nodes: ChatListNode[] = []
  for (const entry of layout) {
    if (entry.kind === 'item') {
      const session = byKey.get(entry.key)
      if (!session) {
        continue
      }
      seen.add(entry.key)
      nodes.push({ type: 'item', item: toLeaf(session, pendingKeys, avatarByAgentId) })
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
          items: items.map((s) => toLeaf(s, pendingKeys, avatarByAgentId)),
        },
      })
    }
  }
  for (const session of sessions) {
    if (!seen.has(session.key)) {
      nodes.push({ type: 'item', item: toLeaf(session, pendingKeys, avatarByAgentId) })
    }
  }
  return nodes
}

function toLayout(nodes: ChatListNode[]): ChatListLayoutEntry[] {
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
  // key forces a remount only when an EXTERNAL input a row displays changes — a
  // session title, membership, or status dot — never on a local order/folder
  // edit. A local edit already lives in the component's own state and is
  // persisted through onChange, so remounting on it would only discard in-flight
  // interaction: fatally for "Move to new folder", whose post-commit inline
  // rename would be reset by the remount before the user can type. Trade-off
  // that remains: an external change still remounts mid-interaction, dropping an
  // in-progress drag or open menu — acceptable until ChatList is made controlled.
  nodesKey: string
  onChange: (nodes: ChatListNode[]) => void
}

// Combines the persisted layout (order + folders) with the live session list
// into the node tree ChatList renders, and persists whatever the component
// reports back via onChange.
export function useChatListNodes(sessions: SessionEntry[], pendingKeys: Set<string>): UseChatListNodesResult {
  const [layout, setLayout] = useState<ChatListLayoutEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [avatarByAgentId, setAvatarByAgentId] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    fetchLayout()
      .then((entries) => {
        if (!cancelled) {
          setLayout(entries)
          setLoaded(true)
        }
      })
      .catch(() => {
        // A failed layout GET must still reveal the list — degrade to a flat,
        // unfoldered view (empty layout + live sessions) rather than leaving
        // `loaded` false and the sidebar empty forever.
        if (!cancelled) {
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
    () => (loaded ? buildNodes(layout, sessions, pendingKeys, avatarByAgentId) : []),
    [loaded, layout, sessions, pendingKeys, avatarByAgentId],
  )
  // Key on external inputs only (see UseChatListNodesResult.nodesKey): each
  // session's identity, display text, avatar and status dot — deliberately NOT
  // the layout order/folders the component owns after mount. Sorted by key so
  // a reordered session fetch alone doesn't trigger a spurious remount.
  // `loaded` is folded in so the initial false->true flip remounts once with
  // the real tree: sessions can arrive (via SSE) before the layout GET
  // returns, which seeds an empty `nodes`, and without this the list would
  // stay empty until the next external change. Avatars resolve async too
  // (their own fetch), so including them lets that arrival trigger its own
  // one-time remount instead of leaving rows stuck on initials.
  const nodesKey = useMemo(
    () =>
      `${loaded}:${JSON.stringify(
        sessions
          .map((s) => ({
            id: s.key,
            title: s.title ?? s.jobName,
            agent: s.agentName,
            avatar: avatarByAgentId.get(s.agentNodeId),
            pending: pendingKeys.has(s.key),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      )}`,
    [loaded, sessions, pendingKeys, avatarByAgentId],
  )

  const onChange = (next: ChatListNode[]) => {
    const entries = toLayout(next)
    setLayout(entries)
    saveLayout(entries)
  }

  return { nodes, nodesKey, onChange }
}
