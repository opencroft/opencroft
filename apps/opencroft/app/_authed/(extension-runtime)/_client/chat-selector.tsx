'use client'

import { MessageCircleMore, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from 'ui/command'
import { GroupChatThreadList } from 'ui/group-chat/group-chat-thread-list'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/popover'
import { Spinner } from 'ui/spinner'

import { useSessionActivityKeys } from '@/app/_authed/(agent)/_lib/use-session-activity'
import { deriveSessionStatus } from '@/app/_authed/(agent)/_shared/session-status'
import type { EmbeddedChatSelection } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import type { GroupChatThreadEntry } from '@/app/_authed/(group-chats)/_server/actions'
import { getGroupChatEmbedView, listGroupChatThreadsView } from '@/app/_authed/(group-chats)/_server/actions'

/** How many threads an empty search shows — the recent ones; a query searches them all. */
const RECENT_COUNT = 8

/**
 * The id a "New chat" starts under. It doubles as the thread's title (the
 * embedded surface titles a thread with its id), so it is a readable stamp
 * rather than an opaque token; seconds keep two quick clicks apart.
 */
function newChatId(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `Chat ${date} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

export interface ChatSelectorProps {
  /** The group chat's slug — same address the embedded chat surface takes. */
  space: string
  /** The current selection, so the open menu can mark the active thread. */
  selection?: EmbeddedChatSelection | null
  onChange: (selection: EmbeddedChatSelection) => void
  /** A larger tap target for touch surfaces; default is the compact header button. */
  size?: 'icon' | 'icon-sm' | 'icon-xs'
  className?: string
}

/**
 * Picks which conversation an embedded chat surface shows: a header button
 * (beside the dock controls) opening a menu with a search field, a "New chat"
 * action, and the chat's recent threads — the same rows the group-chat
 * screen's thread list draws. Also exposed to extension client code through
 * the host API, beside EmbeddedAgentChat.
 */
export function ChatSelector({ space, selection, onChange, size, className }: ChatSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // null = loading; [] with error = the load failed.
  const [threads, setThreads] = useState<GroupChatThreadEntry[] | null>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setThreads(null)
    setError(undefined)
    getGroupChatEmbedView({ data: space })
      .then(async (view) => {
        if (view.state !== 'ok') {
          throw new Error(view.state === 'missing' ? 'This chat does not exist yet.' : 'This chat is not available.')
        }
        const list = await listGroupChatThreadsView({ data: view.chat.id })
        if (!cancelled) {
          setThreads(list)
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setThreads([])
          setError(e instanceof Error ? e.message : String(e))
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, space])

  // The same shared poll the group-chat screen's list reads, so a row here
  // shows the same live state as the same thread there.
  const { pendingKeys, activeKeys, aliveKeys } = useSessionActivityKeys(open && (threads?.length ?? 0) > 0)

  const shown = useMemo(() => {
    const all = [...(threads ?? [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    const q = query.trim().toLowerCase()
    if (!q) {
      return all.slice(0, RECENT_COUNT)
    }
    return all.filter((t) => (t.title ?? '').toLowerCase().includes(q) || t.agent.name.toLowerCase().includes(q))
  }, [threads, query])

  const items = shown.map((t) => ({
    id: t.id,
    title: t.title,
    agent: t.agent,
    createdAt: new Date(t.createdAt),
    disabled: !t.agentIsMember,
    status: deriveSessionStatus(t.sessionKey, { pending: pendingKeys, active: activeKeys, alive: aliveKeys }),
    hasDraft: t.hasDraft,
  }))
  const activeThreadId = selection && 'threadId' in selection ? selection.threadId : undefined

  const pick = (next: EmbeddedChatSelection) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size={size ?? 'icon-xs'}
          aria-label='Choose a chat'
          title='Choose a chat'
          className={className}
        >
          <MessageCircleMore />
        </Button>
      </PopoverTrigger>
      <PopoverContent side='bottom' align='end' className='w-72 p-0'>
        {/* The same Command dress the space selector's menu wears — borderless
            search on a divider, flat rows — so the two header menus read as one
            family. Filtering stays this component's own (the query narrows
            `shown` before rendering), hence shouldFilter off. */}
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder='Search chats…' />
          <CommandList>
            <CommandGroup>
              <CommandItem onSelect={() => pick({ newId: newChatId() })}>
                <SquarePen />
                New chat
              </CommandItem>
            </CommandGroup>
            {threads === null ? (
              <div className='flex justify-center py-3'>
                <Spinner className='size-4 text-muted-foreground' />
              </div>
            ) : error ? (
              <p className='px-3 py-2 text-xs text-muted-foreground'>{error}</p>
            ) : shown.length === 0 ? (
              <p className='px-3 py-2 text-xs text-muted-foreground'>
                {query.trim() ? 'No chats match the search.' : 'No chats yet.'}
              </p>
            ) : (
              <GroupChatThreadList
                threads={items}
                activeId={activeThreadId}
                onSelect={(id) => pick({ threadId: id })}
                className='max-h-72 overflow-y-auto p-1'
              />
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
