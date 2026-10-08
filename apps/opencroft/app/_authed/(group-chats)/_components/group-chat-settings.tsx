'use client'

// The group chat's settings -- the header control to the right of the pin
// toggle, where the avatar cluster and then a members-only popover used to
// stand. Now a dialog with three sections: Members (the picker, unchanged),
// Permissions (the automated-sender grants, unchanged) and Archive (the
// chat's archived threads, drawn by the same GroupChatThreadTree the active
// list uses, over the chat's 'archive' layout).
//
// This owns the requests, the pending and error state, and the candidate
// derivation for Members and Permissions -- app-side because they are facts
// about this group chat rather than shape decisions the kit dialog should
// know. Archive reuses the tree wholesale; what it draws -- the archived
// threads and the archive's layout -- is read when that section is opened,
// the same lazy-on-show pattern the members and senders lists below use for
// the dialog as a whole.

import { EllipsisVertical } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { GroupChatSettingsDialog } from 'ui/group-chat/group-chat-settings-dialog'

import { GroupChatThreadTree } from '@/app/_authed/(group-chats)/_components/group-chat-thread-tree'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { useGroupChatRefresh } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import { useThreadRowStates } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import { EMPTY_THREAD_LAYOUT } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import { useArchivedThreads } from '@/app/_authed/(group-chats)/_lib/use-archived-threads'
import { useThreadLayout } from '@/app/_authed/(group-chats)/_lib/use-thread-layout'
import type {
  DirectoryAgent,
  DirectoryUser,
  GroupChatThreadListEntry,
  GroupChatWriteResult,
  MemberRef,
} from '@/app/_authed/(group-chats)/_server/actions'
import {
  addGroupChatMember,
  getGroupChatThreadLayout,
  listGroupChatMembers,
  listSystemSenders,
  removeGroupChatMember,
  setGroupChatThreadArchived,
} from '@/app/_authed/(group-chats)/_server/actions'

interface Props {
  groupChatId: string
  members: MemberRef[]
  /** Every account, from the narrow directory read. */
  directory: DirectoryUser[]
  /** Every agent of every space, from the same narrow directory read. */
  agents: DirectoryAgent[]
  /** Replaced whenever the host reloads the chat; the Archive section reads
   *  the archive again when it changes. */
  revision: unknown
  /** Opening an archived row leaves the dialog and goes to its thread. */
  onOpenThread: (threadId: string) => void
}

function toPrincipal(principal: { kind: 'user' | 'agent'; id: string }) {
  return principal.kind === 'user'
    ? ({ kind: 'user', userId: principal.id } as const)
    : ({ kind: 'agent', agentNodeId: principal.id } as const)
}

export function GroupChatSettings({ groupChatId, members, directory, agents, revision, onOpenThread }: Props) {
  const refresh = useGroupChatRefresh()

  // Both principal kinds in one list, which is what the picker takes: the
  // picker reads each member's name and face from here, and searches here for
  // whoever is not in yet.
  const candidates = useMemo<MemberCandidate[]>(
    () => [
      ...directory.map((u) => ({ kind: 'user' as const, id: u.id, name: u.name, avatarUrl: u.avatarUrl })),
      ...agents.map((a) => ({ kind: 'agent' as const, id: a.id, name: a.name, avatarUrl: a.avatarUrl })),
    ],
    [directory, agents],
  )

  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()

  // System senders — the per-chat grants that authorize automated pipelines
  // (a schedule's script, the forge webhook) to deliver into this chat's
  // threads. App-side composition rather than a third kind in the kit picker:
  // these are not people to browse for, they are a short list of reserved
  // identifiers. Fetched on open because the loader's MemberRef view carries
  // only user and agent members.
  const [systemGrants, setSystemGrants] = useState<string[]>([])
  const [systemSenders, setSystemSenders] = useState<string[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies(pending): not read in the body — a grant/revoke settling (pending true→false) is what re-fetches the list it just changed
  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    void Promise.all([listGroupChatMembers({ data: groupChatId }), listSystemSenders()])
      .then(([rows, senders]) => {
        if (!cancelled) {
          setSystemGrants(rows.flatMap((r) => (r.principalType === 'system' && r.systemId ? [r.systemId] : [])))
          setSystemSenders(senders)
        }
      })
      .catch(() => {
        if (!cancelled) {
          // A list that failed to load and a chat with no grants render
          // identically, and the difference is the whole point of the panel.
          setSystemGrants([])
          setSystemSenders([])
          setError('Could not load this chat’s automated senders.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, groupChatId, pending])

  const ungrantedSenders = useMemo(
    () => systemSenders.filter((id) => !systemGrants.includes(id)),
    [systemSenders, systemGrants],
  )

  // One pending flag for both, because the picker disables the whole list off
  // it. A refusal (the last user member, a removed principal, ...) comes back
  // as DATA — `{ ok: false, code }` — and is shown in the server's own words;
  // `catch` is for genuine faults, which still throw.
  const run = async (action: () => Promise<GroupChatWriteResult>, fallback: string) => {
    setError(undefined)
    setPending(true)
    try {
      const result = await action()
      const refusal = memberActionRefusal(result)
      if (refusal) {
        setError(refusal)
        return
      }
      // Stay open: managing several people in a row is the common case, and
      // the list re-draws once the data refreshes.
      await refresh()
    } catch (e) {
      setError(failureMessage(e, fallback))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <Button
        type='button'
        variant='ghost'
        size='icon-sm'
        aria-label='Chat settings'
        title='Chat settings'
        onClick={() => setOpen(true)}
      >
        <EllipsisVertical />
      </Button>
      <GroupChatSettingsDialog
        open={open}
        onOpenChange={setOpen}
        members={
          <AddMemberPicker
            candidates={candidates}
            members={members.map((m) => ({ kind: m.kind, id: m.id }))}
            onAdd={(principal) =>
              void run(
                () => addGroupChatMember({ data: { groupChatId, principal: toPrincipal(principal) } }),
                'That member could not be added.',
              )
            }
            adding={pending}
            onRemove={(principal) =>
              void run(
                () => removeGroupChatMember({ data: { groupChatId, principal: toPrincipal(principal) } }),
                'That member could not be removed.',
              )
            }
            removing={pending}
            error={error}
          />
        }
        permissions={
          systemGrants.length > 0 || ungrantedSenders.length > 0 ? (
            <div className='space-y-2'>
              <p className='text-xs text-muted-foreground'>
                Automated senders — a grant lets a scheduled pipeline or webhook deliver into this chat's threads.
              </p>
              {systemGrants.map((systemId) => (
                <div key={systemId} className='flex items-center justify-between gap-2 text-sm'>
                  <span className='font-mono text-xs'>{systemId}</span>
                  <Button
                    variant='ghost'
                    size='sm'
                    disabled={pending}
                    onClick={() =>
                      void run(
                        () => removeGroupChatMember({ data: { groupChatId, principal: { kind: 'system', systemId } } }),
                        'That grant could not be revoked.',
                      )
                    }
                  >
                    Revoke
                  </Button>
                </div>
              ))}
              {/* Offered, not typed: these identifiers are a closed set the
                  server derives from the same map that stamps them, so what
                  can be granted here is exactly what can send. */}
              {ungrantedSenders.length > 0 ? (
                <div className='flex flex-wrap items-center gap-2'>
                  {ungrantedSenders.map((systemId) => (
                    <Button
                      key={systemId}
                      variant='outline'
                      size='sm'
                      disabled={pending}
                      onClick={() =>
                        void run(
                          () => addGroupChatMember({ data: { groupChatId, principal: { kind: 'system', systemId } } }),
                          'That sender could not be granted.',
                        )
                      }
                    >
                      Grant <span className='font-mono text-xs'>{systemId}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <p className='text-sm text-muted-foreground'>No automated senders are granted to this chat.</p>
          )
        }
        archive={
          <GroupChatArchiveSection
            groupChatId={groupChatId}
            revision={revision}
            onOpenThread={(threadId) => {
              onOpenThread(threadId)
              setOpen(false)
            }}
          />
        }
      />
    </>
  )
}

/**
 * The Archive section's content. The dialog mounts only the section on show,
 * so the archive and its layout are read when this section is opened, not
 * when the chat loads or the dialog opens on another section.
 */
function GroupChatArchiveSection({
  groupChatId,
  revision,
  onOpenThread,
}: {
  groupChatId: string
  revision: unknown
  onOpenThread: (threadId: string) => void
}) {
  const refresh = useGroupChatRefresh()
  const archive = useArchivedThreads(groupChatId, true, revision)
  const archivedThreads = archive.state === 'loaded' ? archive.threads : NO_THREADS
  // The same live row state the active list reads, so an archived thread's
  // row (its session can still be mid-turn) never disagrees with the one the
  // active list would have shown it.
  const stateById = useThreadRowStates(archivedThreads)

  // While the archive's own layout loads, the tree draws as unarranged (every
  // thread loose), which is exactly how an actually-unarranged archive looks,
  // so there is no separate loading state to build.
  const [archiveLayout, setArchiveLayout] = useState(EMPTY_THREAD_LAYOUT)
  useEffect(() => {
    let cancelled = false
    getGroupChatThreadLayout({ data: { groupChatId, list: 'archive' } })
      .then((loaded) => {
        if (!cancelled) {
          setArchiveLayout(loaded)
        }
      })
      .catch(() => {
        // Left at EMPTY_THREAD_LAYOUT: the archive draws every thread loose,
        // same fallback the active list's own load-failure would leave it in.
      })
    return () => {
      cancelled = true
    }
  }, [groupChatId])
  const { layout, persist, folderOpen, setFolderOpen } = useThreadLayout(groupChatId, 'archive', archiveLayout)

  // Unarchiving from here has nowhere to show a refusal in place -- unlike the
  // thread screen's own notice -- so it reports the same way Stop process
  // does elsewhere in this dialog's tree: a toast, since nobody's finger is
  // still on the row waiting for an answer.
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

  if (archive.state === 'loading') {
    return <p className='text-sm text-muted-foreground'>Loading archived threads…</p>
  }
  if (archive.state === 'failed') {
    return <p className='text-sm text-muted-foreground'>The archive could not be loaded.</p>
  }
  if (archivedThreads.length === 0) {
    return <p className='text-sm text-muted-foreground'>No threads are archived.</p>
  }
  return (
    <GroupChatThreadTree
      threads={archivedThreads}
      stateById={stateById}
      layout={layout}
      onChange={persist}
      folderOpen={folderOpen}
      onFolderOpenChange={setFolderOpen}
      onSelect={onOpenThread}
      onUnarchive={unarchiveThread}
    />
  )
}

const NO_THREADS: GroupChatThreadListEntry[] = []
