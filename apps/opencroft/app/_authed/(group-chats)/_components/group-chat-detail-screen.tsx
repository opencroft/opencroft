'use client'

// Inside one group chat: its name, its pinned notes, its threads and the
// composer that starts one. The screen the group-chat route draws -- and, since
// the embedded chat gained the same two windows, the one a space canvas or an
// extension view draws inside its chat panel before a thread is open.
//
// One component for both because they were one screen: the route used to hold
// all of this inline, and the embedded surface offered a bare "New chat"
// composer in its place. The data arrives as props -- the route loads it in
// its loader, the embedded panel loads it itself -- and every write refreshes
// through the group-chat refresh context, which is what lets the panels and
// dialogs inside work the same on both hosts.
//
// The header is one line: back, the name, then three controls -- search (the
// field takes the name's place while open), the pins toggle (opens the editor
// under the header) and the chat's menu (members). Renaming the chat is the
// list page's row menu, not this screen's; the topic is gone.
//
// Search asks two questions at once. Thread titles and agent names are matched
// here, on the threads the screen already holds; message text is matched by the
// server, because transcripts are not loaded into the page. Both answers are
// drawn together while a query is typed, and an "Archived" switch in the field
// widens both to the chat's archive.

import { Pin, Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { GroupChatDetail } from 'ui/group-chat/group-chat-detail'
import { type GroupChatMessageHit, GroupChatSearchResults } from 'ui/group-chat/group-chat-search-results'
import { GroupChatThreadList } from 'ui/group-chat/group-chat-thread-list'
import { GroupChatThreadSearch } from 'ui/group-chat/group-chat-thread-search'
import { Toggle } from 'ui/toggle'

import { stopProcessLocal } from '@/app/_authed/(agent)/_server/acp'
import {
  GroupChatThreadDeleteDialog,
  GroupChatThreadRenameDialog,
} from '@/app/_authed/(group-chats)/_components/group-chat-edit-dialogs'
import { GroupChatPinsPanel } from '@/app/_authed/(group-chats)/_components/group-chat-pins-panel'
import { GroupChatSettings } from '@/app/_authed/(group-chats)/_components/group-chat-settings'
import { GroupChatStartThreadComposer } from '@/app/_authed/(group-chats)/_components/group-chat-start-thread-composer'
import { GroupChatThreadTree } from '@/app/_authed/(group-chats)/_components/group-chat-thread-tree'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { useGroupChatRefresh } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
import { useThreadRowStates } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import { threadSessionKey } from '@/app/_authed/(group-chats)/_lib/thread-session-key'
import { useThreadLayout } from '@/app/_authed/(group-chats)/_lib/use-thread-layout'
import type {
  getGroupChatThreadLayout,
  getMyGroupChatView,
  listDirectoryUsersForPicker,
  listGroupChatThreadsView,
  listMyGroupChatPins,
} from '@/app/_authed/(group-chats)/_server/actions'
import { searchGroupChatTranscripts, setGroupChatThreadArchived } from '@/app/_authed/(group-chats)/_server/actions'
import type { listAgentNodes } from '@/app/_authed/(space)/_server/agents'

/** Everything the screen draws, in the shape the server functions answer with. */
export interface GroupChatDetailData {
  chat: Awaited<ReturnType<typeof getMyGroupChatView>>
  threads: Awaited<ReturnType<typeof listGroupChatThreadsView>>
  directory: Awaited<ReturnType<typeof listDirectoryUsersForPicker>>
  agents: Awaited<ReturnType<typeof listAgentNodes>>
  pins: Awaited<ReturnType<typeof listMyGroupChatPins>>
  layout: Awaited<ReturnType<typeof getGroupChatThreadLayout>>
}

/**
 * What the screen's header holds, for a host that draws that header itself:
 * the title area (the name, or the search field while a search is open) and
 * the controls. The embedded chat panel puts these in its window's header, the
 * way it puts an open thread's cluster there, so the panel has one header
 * rather than two. Identity-stable per change of its parts, so a host may
 * hold it in state without a render loop.
 */
export interface GroupChatDetailHeader {
  title: ReactNode
  actions: ReactNode
}

export interface GroupChatDetailScreenProps extends GroupChatDetailData {
  groupChatId: string
  /** The back affordance, when this screen nests inside something. */
  onBack?: () => void
  /** Take the header: when given, the screen draws none of its own and
   *  reports what it would have held, and null on the way out. */
  onHeader?: (header: GroupChatDetailHeader | null) => void
  /** A thread row was chosen -- or a message inside one, in which case `at`
   *  names the turn (its position in the thread) to bring into view. */
  onOpenThread: (threadId: string, at?: { position: number }) => void
  /** The composer started a thread. The host decides what follows -- the
   *  route reloads and navigates, the embedded panel opens it in place. */
  onThreadStarted: (threadId: string) => void
  /** The thread the reader is in, when the screen is drawn beside one. */
  activeThreadId?: string
  className?: string
}

/** A message hit's id in the results list: a message is one position in one thread. */
function messageHitId(hit: { threadId: string; position: number }): string {
  return `${hit.threadId}:${hit.position}`
}

/** The threads whose title or agent name contains `term` (lower-cased), newest first, as list rows. */
function threadTitleMatches(
  list: GroupChatDetailData['threads'],
  term: string,
  stateById: ReturnType<typeof useThreadRowStates>,
) {
  return [...list]
    .filter((t) => (t.title ?? '').toLowerCase().includes(term) || t.agent.name.toLowerCase().includes(term))
    .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
    .map((t) => ({
      id: t.id,
      title: t.title,
      agent: t.agent,
      createdAt: new Date(t.createdAt),
      disabled: !t.agentIsMember,
      ...stateById.get(t.id),
      hasDraft: t.hasDraft,
    }))
}

export function GroupChatDetailScreen({
  groupChatId,
  chat,
  threads,
  directory,
  agents,
  pins,
  layout: loadedLayout,
  onBack,
  onHeader,
  onOpenThread,
  onThreadStarted,
  activeThreadId,
  className,
}: GroupChatDetailScreenProps) {
  // Every write below that is not Delete or Rename (both keep their own
  // confirm dialogs and their own reload) goes through this -- the same
  // route-invalidate-or-host-reload fallback the pins panel and the members
  // dialog already use.
  const refresh = useGroupChatRefresh()

  // Which thread's Delete was chosen — the shared confirm dialog takes over.
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  // Which thread's Rename was chosen. The kit's row reports the id and stops
  // there -- renaming can be refused, so the dialog is where the new title is
  // collected and where a refusal has somewhere to be shown.
  const [renameThreadId, setRenameThreadId] = useState<string | null>(null)
  // The thread search: the header's search button puts a field in the name's
  // place, and a query replaces the thread area with the threads whose title or
  // agent matches plus the messages that contain it. It replaced the chat
  // panel's "Choose a chat" menu, whose search was the one part of it worth
  // keeping. `includeArchived` is part of the search, not of the screen: it
  // goes back to off whenever the search closes.
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [includeArchived, setIncludeArchived] = useState(false)
  // The pins editor, under the header, behind the header's pin toggle. Closed
  // by default: standing notes must not eat the thread area, and the toggle
  // wears the count so a closed panel still says the chat carries some.
  const [pinsOpen, setPinsOpen] = useState(false)

  // The shared session activity, not a second mechanism invented for this
  // screen — one status vocabulary, one source. A thread's sessionKey is
  // exactly the key that activity already reports on; nothing about it is
  // group-chat-specific.
  const threadStateById = useThreadRowStates(threads)

  // The active list draws only non-archived threads; an archived one moved to
  // the chat's own archive, drawn in the settings dialog instead. Split here,
  // once, rather than filtering at each of the three places that draw the
  // active list (the tree, the search results, the count that decides whether
  // to draw a list at all).
  const activeThreads = useMemo(() => threads.filter((t) => !t.archived), [threads])
  const archivedThreads = useMemo(() => threads.filter((t) => t.archived), [threads])

  // Archiving needs no confirm -- it is reversible from the settings dialog's
  // Archive section -- so it fires the same way Stop process does: straight
  // from the row, with a toast standing in for the UI Stop process has none
  // of (a background action nobody's fingers are still on).
  const archiveThread = (threadId: string) => {
    setGroupChatThreadArchived({ data: { threadId, archived: true } })
      .then((result) => {
        if (!result.ok) {
          toast(groupChatAccessMessageForCode(result.code))
          return
        }
        return refresh()
      })
      .catch((err) => {
        console.error('Failed to archive thread', threadId, err)
        toast('That thread could not be archived.')
      })
  }

  // The search's archived matches offer the way back instead of archiving.
  const unarchiveThread = (threadId: string) => {
    setGroupChatThreadArchived({ data: { threadId, archived: false } })
      .then((result) => {
        if (!result.ok) {
          toast(groupChatAccessMessageForCode(result.code))
          return
        }
        return refresh()
      })
      .catch((err) => {
        console.error('Failed to unarchive thread', threadId, err)
        toast('That thread could not be unarchived.')
      })
  }

  const stopThread = (threadId: string) => {
    // The kit hands back the row id -- the THREAD id, not the session key
    // this has to act on; `sessionKey` rides on every list entry. Same server
    // fn the sidebar chat list's own Stop process calls, so there is one way
    // to stop a process, not two. Nothing is invalidated afterwards: the row's
    // state comes from the shared session activity, which the server pushes
    // when the process goes.
    const sessionKey = threadSessionKey(threads, threadId)
    if (!sessionKey) {
      return
    }
    stopProcessLocal({ data: sessionKey }).catch((err) => {
      console.error('Failed to stop thread process', threadId, err)
    })
  }

  // The arrangement is owned here rather than inside the list, so the list
  // stays presentational and every write goes through one hook, one store and
  // one compare-and-swap guard. A refused write is answered by adopting the
  // arrangement that won, which is state a presentational list cannot hold.
  const { layout, persist } = useThreadLayout(groupChatId, 'active', loadedLayout)
  const threadTree = (
    <GroupChatThreadTree
      threads={activeThreads}
      stateById={threadStateById}
      layout={layout}
      onChange={persist}
      activeId={activeThreadId}
      onSelect={(threadId) => onOpenThread(threadId)}
      onStopProcess={stopThread}
      onRename={(threadId) => setRenameThreadId(threadId)}
      onDelete={(threadId) => setDeleteTarget(threadId)}
      onArchive={archiveThread}
    />
  )

  // A query is answered with FLAT lists, newest first, not the tree: folders
  // arrange threads, and a search is a question about names that cuts across
  // any arrangement. Same rows the tree draws, same context menu behind them.
  // Archived matches are a list of their own because their menu differs --
  // Unarchive instead of Archive -- and the kit's list offers one or the other.
  const searchTerm = query.trim()
  const trimmedQuery = searchTerm.toLowerCase()
  const matches = useMemo(
    () => (trimmedQuery ? threadTitleMatches(activeThreads, trimmedQuery, threadStateById) : []),
    [activeThreads, trimmedQuery, threadStateById],
  )
  const archivedMatches = useMemo(
    () => (trimmedQuery && includeArchived ? threadTitleMatches(archivedThreads, trimmedQuery, threadStateById) : []),
    [archivedThreads, trimmedQuery, includeArchived, threadStateById],
  )

  // The message half of the search. Debounced, because every keystroke would
  // otherwise be a full-text query; the id guards the answer, because two
  // requests can finish in the other order and the older one must not
  // overwrite the newer. The answer carries the key it was asked for, so a
  // result for "ab" is never drawn under "abc" while that one is in flight.
  const searchKey = `${searchTerm}\n${includeArchived}`
  const [messageSearch, setMessageSearch] = useState<{
    key: string
    hits: Awaited<ReturnType<typeof searchGroupChatTranscripts>>['hits']
    truncated: boolean
  } | null>(null)
  const searchRequestId = useRef(0)
  useEffect(() => {
    if (!searchTerm) {
      setMessageSearch(null)
      return
    }
    const timer = setTimeout(() => {
      const requestId = ++searchRequestId.current
      searchGroupChatTranscripts({ data: { groupChatId, query: searchTerm, includeArchived } })
        .then((result) => {
          if (requestId === searchRequestId.current) {
            setMessageSearch({ key: searchKey, hits: result.hits, truncated: result.truncated })
          }
        })
        .catch((err) => {
          console.error('Failed to search thread messages', err)
          if (requestId === searchRequestId.current) {
            setMessageSearch({ key: searchKey, hits: [], truncated: false })
          }
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      // Whatever is in flight was asked for a query that is gone.
      searchRequestId.current++
    }
  }, [groupChatId, searchTerm, includeArchived, searchKey])
  const currentMessageSearch = messageSearch?.key === searchKey ? messageSearch : null
  const messageHits = useMemo<GroupChatMessageHit[]>(() => {
    const byId = new Map(threads.map((t) => [t.id, t] as const))
    return (currentMessageSearch?.hits ?? []).flatMap((hit) => {
      const thread = byId.get(hit.threadId)
      // A thread deleted since the answer was computed has nothing to open.
      if (!thread) {
        return []
      }
      return [
        {
          id: messageHitId(hit),
          threadTitle: thread.title,
          agent: thread.agent,
          role: hit.role,
          snippet: hit.snippet,
          archived: thread.archived,
        },
      ]
    })
  }, [currentMessageSearch, threads])
  const selectMessage = (hitId: string) => {
    const hit = currentMessageSearch?.hits.find((h) => messageHitId(h) === hitId)
    if (hit) {
      onOpenThread(hit.threadId, { position: hit.turn })
    }
  }
  // The header's two parts, memoized on exactly what they read so a host that
  // holds them in state is told once per real change. While a search is open
  // the field is the whole header: the other controls step aside, and the
  // field's own X is the way out.
  const header = useMemo<GroupChatDetailHeader>(() => {
    const closeSearch = () => {
      setSearching(false)
      setQuery('')
      setIncludeArchived(false)
    }
    const title = searching ? (
      <GroupChatThreadSearch
        query={query}
        onQueryChange={setQuery}
        includeArchived={includeArchived}
        onIncludeArchivedChange={setIncludeArchived}
        onClose={closeSearch}
      />
    ) : null
    const actions = searching ? null : (
      <>
        {threads.length > 0 ? (
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            aria-label='Search threads'
            title='Search threads'
            onClick={() => setSearching(true)}
          >
            <Search />
          </Button>
        ) : null}
        <Toggle
          size='sm'
          pressed={pinsOpen}
          onPressedChange={setPinsOpen}
          aria-label={pinsOpen ? 'Hide pinned notes' : 'Show pinned notes'}
          title='Pinned notes'
        >
          <Pin />
        </Toggle>
        <GroupChatSettings
          groupChatId={groupChatId}
          members={chat.members}
          directory={directory}
          agents={agents}
          archivedThreads={archivedThreads}
          stateById={threadStateById}
          onOpenThread={onOpenThread}
        />
      </>
    )
    return { title, actions }
  }, [
    searching,
    query,
    includeArchived,
    pinsOpen,
    threads.length,
    groupChatId,
    chat.members,
    directory,
    agents,
    archivedThreads,
    threadStateById,
    onOpenThread,
  ])
  // Reported through a ref so an inline callback never re-arms this, and
  // cleared on the way out: a host that took the header must hear that it is
  // gone, or its window keeps a search field over nothing.
  const onHeaderRef = useRef(onHeader)
  onHeaderRef.current = onHeader
  const hostDrawsHeader = onHeader !== undefined
  useEffect(() => {
    if (!hostDrawsHeader) {
      return
    }
    onHeaderRef.current?.(header)
    return () => onHeaderRef.current?.(null)
  }, [header, hostDrawsHeader])
  // The title matches are drawn here and handed to the results as a slot, so a
  // match is the same row, with the same menu, as in the thread list itself.
  const titleMatchRows =
    matches.length > 0 || archivedMatches.length > 0 ? (
      <>
        {matches.length > 0 ? (
          <GroupChatThreadList
            threads={matches}
            activeId={activeThreadId}
            onSelect={(threadId) => onOpenThread(threadId)}
            onRename={(threadId) => setRenameThreadId(threadId)}
            onStopProcess={stopThread}
            onDelete={(threadId) => setDeleteTarget(threadId)}
            onArchive={archiveThread}
          />
        ) : null}
        {archivedMatches.length > 0 ? (
          <GroupChatThreadList
            threads={archivedMatches}
            activeId={activeThreadId}
            onSelect={(threadId) => onOpenThread(threadId)}
            onDelete={(threadId) => setDeleteTarget(threadId)}
            onUnarchive={unarchiveThread}
          />
        ) : null}
      </>
    ) : undefined
  const threadArea = trimmedQuery ? (
    <GroupChatSearchResults
      threads={titleMatchRows}
      messages={messageHits}
      onSelectMessage={selectMessage}
      loading={currentMessageSearch === null}
      truncated={currentMessageSearch?.truncated}
    />
  ) : activeThreads.length > 0 ? (
    threadTree
  ) : undefined

  const threadBeingRenamed = threads.find((t) => t.id === renameThreadId)

  return (
    <>
      {/* GroupChatDetail is its own full-height column -- header, a scrolling
          thread area, and a composer pinned under it -- so it goes straight
          into whatever frame holds it. It must NOT be wrapped in a scroll
          container: inside one, its height resolves against content rather
          than the viewport, the thread area stops being the thing that
          scrolls, and the composer rides up to sit under the last thread
          instead of staying at the bottom. */}
      <GroupChatDetail
        className={className}
        onBack={onBack}
        name={chat.name}
        searchField={header.title ?? undefined}
        actions={header.actions ?? undefined}
        headerless={hostDrawsHeader}
        panel={pinsOpen ? <GroupChatPinsPanel groupChatId={groupChatId} pins={pins} /> : undefined}
        threads={threadArea}
        emptyState={
          <Empty className='py-8'>
            <EmptyHeader>
              <EmptyTitle>No threads yet</EmptyTitle>
              <EmptyDescription>
                A group chat holds no messages of its own. Each thread inside it is a conversation with one agent.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        }
        composer={
          <GroupChatStartThreadComposer
            groupChatId={groupChatId}
            members={chat.members}
            onThreadStarted={onThreadStarted}
          />
        }
      />

      {/* Keyed on the thread id so the dialog's draft is seeded from the row
          actually chosen -- without it, opening Rename on a second thread would
          reuse the first one's mounted state and offer the wrong title. */}
      {threadBeingRenamed ? (
        <GroupChatThreadRenameDialog
          key={threadBeingRenamed.id}
          open
          onOpenChange={(next) => {
            if (!next) {
              setRenameThreadId(null)
            }
          }}
          threadId={threadBeingRenamed.id}
          title={threadBeingRenamed.title ?? ''}
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
