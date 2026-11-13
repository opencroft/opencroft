'use client'

// The group chat's settings -- the header control to the right of the pin
// toggle -- as a dialog with three sections: Members (the picker), Permissions
// (the automated-sender grants) and Archive (the chat's archived threads,
// drawn by the same GroupChatThreadTree the active list uses, over the chat's
// 'archive' layout).
//
// This owns the requests, the pending and error state, and the candidate
// derivation for Members and Permissions -- app-side because they are facts
// about this group chat rather than shape decisions the kit dialog should
// know. Archive reuses the tree wholesale; what it draws -- the archived
// threads and the archive's layout -- is read when that section is opened,
// the same lazy-on-show pattern the senders list below uses for the dialog as
// a whole. While the dialog is open, every section follows changes made
// anywhere else, as the server reports them.

import { EllipsisVertical } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { AutomatedSenderGrants } from 'ui/group-chat/automated-sender-grants'
import { GroupChatSettingsDialog } from 'ui/group-chat/group-chat-settings-dialog'

import { GroupChatThreadTree } from '@/app/_authed/(group-chats)/_components/group-chat-thread-tree'
import { useGroupChatChanges } from '@/app/_authed/(group-chats)/_lib/group-chat-changes'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { useGroupChatRefresh } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
import { useThreadRowStates } from '@/app/_authed/(group-chats)/_lib/thread-row-state'
import { EMPTY_THREAD_LAYOUT } from '@/app/_authed/(group-chats)/_lib/thread-tree-layout'
import { useArchivedThreads } from '@/app/_authed/(group-chats)/_lib/use-archived-threads'
import { useChatWrite } from '@/app/_authed/(group-chats)/_lib/use-chat-write'
import { useSystemSenderGrants } from '@/app/_authed/(group-chats)/_lib/use-system-sender-grants'
import { useThreadLayout } from '@/app/_authed/(group-chats)/_lib/use-thread-layout'
import type {
  DirectoryAgent,
  DirectoryUser,
  GroupChatThreadListEntry,
  MemberRef,
} from '@/app/_authed/(group-chats)/_server/actions'
import {
  addGroupChatMember,
  getGroupChatThreadLayout,
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
  const memberWrite = useChatWrite(refresh)
  const grantWrite = useChatWrite(refresh)

  // System senders — the per-chat grants that authorize automated pipelines
  // (a schedule's script, the forge webhook) to deliver into this chat's
  // threads. Read while the dialog is open, because the loader's MemberRef
  // view carries only user and agent members; read again after each grant or
  // revoke settles, and after each change the server reports.
  const [sendersRead, setSendersRead] = useState(0)
  const senders = useSystemSenderGrants(groupChatId, open, `${sendersRead}:${grantWrite.settled}`)

  // While the dialog is open, a change to this chat made anywhere else -- by
  // another tab, an agent, an App action -- reloads what every section shows:
  // the members and the archive through the host's reload, the grants here.
  useGroupChatChanges(groupChatId, open, () => {
    setSendersRead((n) => n + 1)
    void refresh().catch(() => {
      // The next change, or reopening the dialog, reads it again.
    })
  })

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
              memberWrite.run(
                () => addGroupChatMember({ data: { groupChatId, principal: toPrincipal(principal) } }),
                'That member could not be added.',
              )
            }
            adding={memberWrite.pending}
            onRemove={(principal) =>
              memberWrite.run(
                () => removeGroupChatMember({ data: { groupChatId, principal: toPrincipal(principal) } }),
                'That member could not be removed.',
              )
            }
            removing={memberWrite.pending}
            error={memberWrite.error}
            // The section scrolls as a whole; a second scroll inside it would
            // hide the last members while the dialog has room for them.
            scrollsInside={false}
          />
        }
        permissions={
          // Offered, not typed: these identifiers are a closed set the server
          // derives from the same map that stamps them.
          <AutomatedSenderGrants
            granted={senders.granted}
            grantable={senders.grantable}
            loading={senders.state === 'loading'}
            loadError={senders.state === 'failed' ? 'This chat’s automated senders could not be loaded.' : undefined}
            onGrant={(systemId) =>
              grantWrite.run(
                () => addGroupChatMember({ data: { groupChatId, principal: { kind: 'system', systemId } } }),
                'That sender could not be granted.',
              )
            }
            onRevoke={(systemId) =>
              grantWrite.run(
                () => removeGroupChatMember({ data: { groupChatId, principal: { kind: 'system', systemId } } }),
                'That grant could not be revoked.',
              )
            }
            pending={grantWrite.pending}
            error={grantWrite.error}
          />
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
  // Read again with the archive itself: a thread archived elsewhere arrives in
  // its folder there, which is a newer layout this tree takes by its version.
  const [archiveLayout, setArchiveLayout] = useState(EMPTY_THREAD_LAYOUT)
  // biome-ignore lint/correctness/useExhaustiveDependencies(revision): not read in the body -- the host replacing it is what asks for a fresh read
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
  }, [groupChatId, revision])
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
