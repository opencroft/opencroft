'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

// ── Types ──────────────────────────────────────────────────────────────

export interface ChatTab {
  key: string;
  label: string;
  agentName?: string;
  agentAvatar?: string | null;
}

interface TabMeta {
  label?: string;
  agentName?: string;
  agentAvatar?: string | null;
}

// ── Storage ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'opencroft.aiPanel.openTabs';

function loadStoredTabs(): ChatTab[] {
  if (typeof window === 'undefined') {
    return [];
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistTabs(tabs: ChatTab[]) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
}

function makeTab(key: string, meta?: TabMeta): ChatTab {
  return {
    key,
    label: meta?.label || key.split(':').pop() || key,
    agentName: meta?.agentName,
    agentAvatar: meta?.agentAvatar,
  };
}

// ── Context ────────────────────────────────────────────────────────────

interface ChatTabsContextValue {
  tabs: ChatTab[];
  activeSessionKey: string;
  selectSession: (key: string) => void;
  closeTab: (key: string) => void;
  setActiveKey: (key: string) => void;
  openTab: (key: string, meta?: TabMeta) => void;
  updateTabMeta: (key: string, meta: TabMeta) => void;
  fallbackKey: string;
  setFallbackKey: (key: string) => void;
}

const ChatTabsContext = createContext<ChatTabsContextValue | null>(null);

export function useChatTabs(): ChatTabsContextValue {
  const ctx = useContext(ChatTabsContext);
  if (!ctx) {
    throw new Error('useChatTabs must be used within ChatTabsProvider');
  }
  return ctx;
}

export function useChatTabsMaybe(): ChatTabsContextValue | null {
  return useContext(ChatTabsContext);
}

// ── Provider ───────────────────────────────────────────────────────────

export function ChatTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<ChatTab[]>([]);
  const [activeSessionKey, setActiveSessionKey] = useState<string>('');
  const [fallbackKey, setFallbackKey] = useState('');
  const initialized = useRef(false);

  // Load from localStorage on mount
  useEffect(() => {
    if (initialized.current) {
      return;
    }
    initialized.current = true;
    const stored = loadStoredTabs();
    setTabs(stored);

    // If there's a chat param in URL, use it as active
    const params = new URLSearchParams(window.location.search);
    const chatParam = params.get('chat');
    if (chatParam) {
      setActiveSessionKey(chatParam);
    } else if (stored.length > 0) {
      setActiveSessionKey(stored[0].key);
    }
  }, []);

  const openTab = useCallback((key: string, meta?: TabMeta) => {
    setTabs((prev) => {
      if (prev.some((t) => t.key === key)) {
        return prev;
      }
      const next = [...prev, makeTab(key, meta)];
      persistTabs(next);
      return next;
    });
  }, []);

  const selectSession = useCallback((key: string) => {
    setActiveSessionKey(key);
    setTabs((prev) => {
      if (prev.some((t) => t.key === key)) {
        return prev;
      }
      const next = [...prev, makeTab(key)];
      persistTabs(next);
      return next;
    });
  }, []);

  const closeTab = useCallback((key: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.key !== key);
      persistTabs(next);
      return next;
    });
    setActiveSessionKey((current) => {
      if (current !== key) {
        return current;
      }
      return fallbackKey;
    });
  }, [fallbackKey]);

  const setActiveKey = useCallback((key: string) => {
    setActiveSessionKey(key);
  }, []);

  const updateTabMeta = useCallback((key: string, meta: TabMeta) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.key === key);
      if (idx === -1) {
        return prev;
      }
      const merged = { ...prev[idx], ...meta };
      const unchanged = merged.label === prev[idx].label
        && merged.agentName === prev[idx].agentName
        && merged.agentAvatar === prev[idx].agentAvatar;
      if (unchanged) {
        return prev;
      }
      const next = [...prev];
      next[idx] = merged;
      persistTabs(next);
      return next;
    });
  }, []);

  const value = useMemo<ChatTabsContextValue>(() => ({
    tabs,
    activeSessionKey,
    selectSession,
    closeTab,
    setActiveKey,
    openTab,
    updateTabMeta,
    fallbackKey,
    setFallbackKey,
  }), [tabs, activeSessionKey, selectSession, closeTab, setActiveKey, openTab, updateTabMeta, fallbackKey]);

  return (
    <ChatTabsContext.Provider value={value}>
      {children}
    </ChatTabsContext.Provider>
  );
}
