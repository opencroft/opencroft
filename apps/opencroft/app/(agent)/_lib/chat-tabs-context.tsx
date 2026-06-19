'use client'

import { useLocation, useRouter } from '@tanstack/react-router'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

// ── Types ──────────────────────────────────────────────────────────────

export interface ChatTab {
  key: string
  label: string
  agentName?: string
  agentAvatar?: string | null
}

// Docked = chat lives in the node inspector panel; focused = chat opens as the
// floating canvas overlay.
export type ChatMode = 'docked' | 'focused'

interface TabMeta {
  label?: string
  agentName?: string
  agentAvatar?: string | null
}

// ── Storage ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'opencroft.aiPanel.openTabs'
const MODE_STORAGE_KEY = 'opencroft.aiPanel.chatMode'

function loadStoredMode(): ChatMode {
  if (typeof window === 'undefined') {
    return 'docked'
  }
  return window.localStorage.getItem(MODE_STORAGE_KEY) === 'focused' ? 'focused' : 'docked'
}

function loadStoredTabs(): ChatTab[] {
  if (typeof window === 'undefined') {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
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

function persistTabs(tabs: ChatTab[]) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs))
}

function makeTab(key: string, meta?: TabMeta): ChatTab {
  return {
    key,
    label: meta?.label || key.split(':').pop() || key,
    agentName: meta?.agentName,
    agentAvatar: meta?.agentAvatar,
  }
}

// ── Context ────────────────────────────────────────────────────────────

interface ChatTabsContextValue {
  tabs: ChatTab[]
  activeSessionKey: string
  selectSession: (key: string) => void
  closeTab: (key: string) => void
  setActiveKey: (key: string) => void
  openTab: (key: string, meta?: TabMeta) => void
  updateTabMeta: (key: string, meta: TabMeta) => void
  fallbackKey: string
  setFallbackKey: (key: string) => void
  chatMode: ChatMode
  toggleChatMode: () => void
  // Bumped to ask the canvas to open the chat list (docked or overlay, per mode).
  // Lets the sidebar — which lives above the overlay provider — trigger it.
  listRequest: number
  openChatList: () => void
}

const ChatTabsContext = createContext<ChatTabsContextValue | null>(null)

export function useChatTabs(): ChatTabsContextValue {
  const ctx = useContext(ChatTabsContext)
  if (!ctx) {
    throw new Error('useChatTabs must be used within ChatTabsProvider')
  }
  return ctx
}

export function useChatTabsMaybe(): ChatTabsContextValue | null {
  return useContext(ChatTabsContext)
}

// ── Provider ───────────────────────────────────────────────────────────

export function ChatTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<ChatTab[]>([])
  // The active session is the single source of truth; seed it once from the URL
  // (deep-link support) and mirror it back to the URL below.
  const [activeSessionKey, setActiveSessionKey] = useState<string>(() =>
    typeof window === 'undefined' ? '' : (new URLSearchParams(window.location.search).get('chat') ?? ''),
  )
  const [fallbackKey, setFallbackKey] = useState('')
  const [chatMode, setChatMode] = useState<ChatMode>('docked')
  const [listRequest, setListRequest] = useState(0)
  const initialized = useRef(false)
  const router = useRouter()
  const pathname = useLocation({ select: (l) => l.pathname })
  const searchStr = useLocation({ select: (l) => l.searchStr })

  // Load open tabs from localStorage on mount. (No auto-select — the chat opens
  // only when a session is chosen, so the inspector lands on the list, not a
  // forced conversation.)
  useEffect(() => {
    if (initialized.current) {
      return
    }
    initialized.current = true
    setTabs(loadStoredTabs())
    setChatMode(loadStoredMode())
  }, [])

  const toggleChatMode = useCallback(() => {
    setChatMode((prev) => {
      const next = prev === 'focused' ? 'docked' : 'focused'
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(MODE_STORAGE_KEY, next)
      }
      return next
    })
  }, [])

  // Mirror the active session into the URL (?chat=) — one source of truth, the
  // URL just reflects it. Clearing it (back / close → the fallback key) drops it.
  useEffect(() => {
    const real = !!activeSessionKey && activeSessionKey !== fallbackKey
    const desired = real ? activeSessionKey : null
    const params = new URLSearchParams(searchStr)
    if ((params.get('chat') ?? null) === desired) {
      return
    }
    // Rebuild the search object from scratch (preserving other params) and pass
    // it as a plain object — a function updater here merges with prev, so a
    // removed/undefined `chat` key is dropped on the floor and never cleared.
    const next: Record<string, string> = {}
    params.forEach((value, key) => {
      if (key !== 'chat') {
        next[key] = value
      }
    })
    if (desired) {
      next.chat = desired
    }
    router.navigate({ to: pathname, replace: true, search: next })
  }, [activeSessionKey, fallbackKey, pathname, searchStr, router])

  const openTab = useCallback((key: string, meta?: TabMeta) => {
    setTabs((prev) => {
      if (prev.some((t) => t.key === key)) {
        return prev
      }
      const next = [...prev, makeTab(key, meta)]
      persistTabs(next)
      return next
    })
  }, [])

  const selectSession = useCallback((key: string) => {
    setActiveSessionKey(key)
    setTabs((prev) => {
      if (prev.some((t) => t.key === key)) {
        return prev
      }
      const next = [...prev, makeTab(key)]
      persistTabs(next)
      return next
    })
  }, [])

  const closeTab = useCallback(
    (key: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.key !== key)
        persistTabs(next)
        return next
      })
      setActiveSessionKey((current) => {
        if (current !== key) {
          return current
        }
        return fallbackKey
      })
    },
    [fallbackKey],
  )

  const setActiveKey = useCallback((key: string) => {
    setActiveSessionKey(key)
  }, [])

  const openChatList = useCallback(() => {
    // Drop the active session at the source so the canvas lands on the list (not
    // a conversation), then signal the canvas to surface it.
    setActiveSessionKey(fallbackKey)
    setListRequest((n) => n + 1)
  }, [fallbackKey])

  const updateTabMeta = useCallback((key: string, meta: TabMeta) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key)
      if (idx === -1) {
        return prev
      }
      const merged = { ...prev[idx], ...meta }
      const unchanged =
        merged.label === prev[idx].label &&
        merged.agentName === prev[idx].agentName &&
        merged.agentAvatar === prev[idx].agentAvatar
      if (unchanged) {
        return prev
      }
      const next = [...prev]
      next[idx] = merged
      persistTabs(next)
      return next
    })
  }, [])

  const value = useMemo<ChatTabsContextValue>(
    () => ({
      tabs,
      activeSessionKey,
      selectSession,
      closeTab,
      setActiveKey,
      openTab,
      updateTabMeta,
      fallbackKey,
      setFallbackKey,
      chatMode,
      toggleChatMode,
      listRequest,
      openChatList,
    }),
    [
      tabs,
      activeSessionKey,
      selectSession,
      closeTab,
      setActiveKey,
      openTab,
      updateTabMeta,
      fallbackKey,
      chatMode,
      toggleChatMode,
      listRequest,
      openChatList,
    ],
  )

  return <ChatTabsContext.Provider value={value}>{children}</ChatTabsContext.Provider>
}
