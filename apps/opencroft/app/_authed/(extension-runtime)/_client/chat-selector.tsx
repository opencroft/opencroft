'use client'

import { Link } from '@tanstack/react-router'
import { MessageCircleMore, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from 'ui/command'
import { GroupChatThreadList } from 'ui/group-chat/group-chat-thread-list'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/popover'
import { Spinner } from 'ui/spinner'

import { stopProcessLocal } from '@/app/_authed/(agent)/_server/acp'
import type { EmbeddedChatSelection } from '@/app/_authed/(extension-runtime)/_client/embedded-agent-chat'
import {
  GroupChatThreadDeleteDialog,
  GroupChatThreadRenameDialog,
} from '@/app/_authed/(group-chats)/_components/group-chat-edit-dialogs'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { useThreadRowStates } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import { threadSessionKey } from '@/app/_authed/(group-chats)/_lib/thread-session-key'
import type { GroupChatThreadListEntry } from '@/app/_authed/(group-chats)/_server/actions'
import {
  getGroupChatEmbedView,
  listGroupChatThreadsView,
  setGroupChatThreadArchived,
} from '@/app/_authed/(group-chats)/_server/actions'

// One empty list for "not loaded", so the row states memoised on it are not
// rebuilt on every render while the menu is closed.
const NO_THREADS: GroupChatThreadListEntry[] = []

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
 * action, and every thread the chat has — the same rows the group-chat
 * screen's thread list draws, with the same per-row context menu (Rename /
 * Stop process / Delete) behind them and a More footer leading to the chat's
 * own screen. Also exposed to extension client code through the host API,
 * beside EmbeddedAgentChat.
 */
export function ChatSelector({ space, selection, onChange, size, className }: ChatSelectorProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // null = loading; [] with error = the load failed.
  const [threads, setThreads] = useState<GroupChatThreadListEntry[] | null>(null)
  const [error, setError] = useState<string>()
  // The chat's id, once resolved — the More footer links to its screen by it.
  const [chatId, setChatId] = useState<string | null>(null)
  // Which row's Rename / Delete was chosen; the same host-side dialogs the
  // group-chat screen opens take over, outside the popover so closing it does
  // not unmount them.
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setThreads(null)
    setError(undefined)
    setChatId(null)
    getGroupChatEmbedView({ data: space })
      .then(async (view) => {
        if (view.state !== 'ok') {
          throw new Error(view.state === 'missing' ? 'This chat does not exist yet.' : 'This chat is not available.')
        }
        if (!cancelled) {
          setChatId(view.chat.id)
        }
        // Archived threads are the chat's archive, not its thread list; they
        // are reached from the chat's settings, as on the chat's own screen.
        const list = await listGroupChatThreadsView({ data: { groupChatId: view.chat.id, list: 'active' } })
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

  // The same shared session activity the group-chat screen's list reads, so a
  // row here shows the same live state as the same thread there.
  const stateById = useThreadRowStates(threads ?? NO_THREADS)

  // EVERY thread of the chat, newest first — the menu is bounded by its own
  // scroll box (the kit's CommandList, 300px) rather than by a count.
  //
  // There was a cap of eight here, and it was applied to a sort by CREATION
  // time. The two together are what made it wrong rather than merely small: a
  // chat's oldest threads are the ones that have been going longest, so they
  // sort last and were precisely the ones dropped. Measured 10.09.2026 on a
  // chat of twelve — the four it hid were the four oldest, and each of them
  // was a conversation in daily use. Nothing on the menu said anything was
  // missing, and the search field only reached them if you already knew a name
  // to type, which is the one thing a chooser is for not needing.
  //
  // The cap saved nothing either way: the server applies no limit of its own,
  // so every thread is already loaded and in memory by the time this runs.
  const shown = useMemo(() => {
    const all = [...(threads ?? [])].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    const q = query.trim().toLowerCase()
    if (!q) {
      return all
    }
    return all.filter((t) => (t.title ?? '').toLowerCase().includes(q) || t.agent.name.toLowerCase().includes(q))
  }, [threads, query])

  const items = shown.map((t) => ({
    id: t.id,
    title: t.title,
    agent: t.agent,
    createdAt: new Date(t.createdAt),
    disabled: !t.agentIsMember,
    ...stateById.get(t.id),
    hasDraft: t.hasDraft,
  }))
  const activeThreadId = selection && 'threadId' in selection ? selection.threadId : undefined

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  const pick = (next: EmbeddedChatSelection) => {
    onChange(next)
    close()
  }

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            setQuery('')
          }
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant='ghost'
              size={size ?? 'icon-xs'}
              aria-label='Choose a chat'
              title='Choose a chat'
              className={className}
            />
          }
        >
          <MessageCircleMore />
        </PopoverTrigger>
        <PopoverContent side='bottom' align='end' className='w-72 gap-0 p-0'>
          {/* The same Command dress the space selector's menu wears — borderless
            search on a divider, flat rows — so the two header menus read as one
            family. Filtering stays this component's own (the query narrows
            `shown` before rendering), hence shouldFilter off. */}
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder='Search chats…' />
            <CommandList>
              <CommandGroup>
                {/* The chat's home screen, where a thread is started -- the
                    embedded surface draws it in place of the bare "New chat"
                    composer it used to offer, so this leads there rather than
                    minting a titled thread of its own. */}
                <CommandItem onSelect={() => pick({ home: true })}>
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
                  // The same row actions the group-chat screen's thread tree
                  // offers, wired the same way: Rename and Delete report the row
                  // and a host dialog takes over; Stop maps the thread id to its
                  // session key and calls the one shared stop path. The row's
                  // state comes from the shared session activity, so nothing needs
                  // reloading after a stop.
                  onRename={(id) => {
                    const thread = (threads ?? []).find((t) => t.id === id)
                    if (thread) {
                      setRenameTarget({ id, title: thread.title ?? '' })
                      close()
                    }
                  }}
                  onStopProcess={(id) => {
                    const sessionKey = threadSessionKey(threads ?? [], id)
                    if (!sessionKey) {
                      return
                    }
                    stopProcessLocal({ data: sessionKey }).catch((err) => {
                      console.error('Failed to stop thread process', id, err)
                    })
                  }}
                  onDelete={(id) => {
                    setDeleteTarget(id)
                    close()
                  }}
                  // Beside Delete, as on the chat's own screen. No confirm: it
                  // is undone from the chat's settings.
                  onArchive={(id) => {
                    setGroupChatThreadArchived({ data: { threadId: id, archived: true } })
                      .then((result) => {
                        if (!result.ok) {
                          toast(groupChatAccessMessageForCode(result.code))
                          return
                        }
                        setThreads((prev) => prev?.map((t) => (t.id === id ? { ...t, archived: true } : t)) ?? null)
                      })
                      .catch((err) => {
                        console.error('Failed to archive thread', id, err)
                        toast('That thread could not be archived.')
                      })
                  }}
                  // No scroll of its own — the CommandList above is the menu's
                  // one scroll container, and a second nested one splits the
                  // wheel between two scrollbars.
                  className='p-1'
                />
              )}
            </CommandList>
          </Command>
          {/* Same footer the space selector's menu ends with: the full screen
            behind this menu, one click away. Rendered once the chat resolved —
            the id is what the link needs. */}
          {chatId ? (
            <div className='border-t p-1'>
              <Button
                render={<Link to='/group-chats/$groupChatId' params={{ groupChatId: chatId }} />}
                nativeButton={false}
                variant='ghost'
                size='sm'
                className='w-full justify-center'
                onClick={close}
              >
                More
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      {renameTarget ? (
        <GroupChatThreadRenameDialog
          key={renameTarget.id}
          open
          onOpenChange={(next) => {
            if (!next) {
              setRenameTarget(null)
            }
          }}
          threadId={renameTarget.id}
          title={renameTarget.title}
        />
      ) : null}
      {deleteTarget ? (
        <GroupChatThreadDeleteDialog
          key={deleteTarget}
          open
          onOpenChange={(next) => {
            if (!next) {
              setDeleteTarget(null)
            }
          }}
          threadId={deleteTarget}
        />
      ) : null}
    </>
  )
}
