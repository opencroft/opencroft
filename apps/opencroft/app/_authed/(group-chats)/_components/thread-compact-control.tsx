'use client'

// A compaction trigger + status indicator for a group-chat thread's composer,
// wired to compactGroupChatThread/getGroupChatThreadCompactStatus (the
// group-chat thread compaction machinery). Visual language matches
// ContextRing -- the one existing async-status affordance in agent-chat --
// since nothing in this app currently exposes a MANUAL compact trigger to a
// user: the async scheduling fix this was meant to mirror (queue-behind-the-
// turn, coalescing) lives entirely on the send-message node action, used by
// agents managing sessions via MCP, not by an end user in a chat screen.
//
// Polls status while a job is pending/running; stops once it settles. Seeds
// status on mount so reopening a thread mid-compaction (started from another
// tab, or by someone else) shows the real state instead of assuming idle.
import { Loader2, Shrink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from 'ui/button'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/popover'

import type { CompactStatus } from '@/app/_authed/(extension-runtime)/_server/stream'
import { groupChatAccessMessage } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { compactGroupChatThread, getGroupChatThreadCompactStatus } from '@/app/_authed/(group-chats)/_server/actions'

const POLL_INTERVAL_MS = 2000

function formatCount(n: number): string {
  return n.toLocaleString()
}

export function statusLabel(status: CompactStatus | null): string {
  if (!status || status.state === 'never-requested') {
    return 'Compact this thread to free up context space.'
  }
  if (status.state === 'pending' || status.state === 'running') {
    return 'Compacting…'
  }
  if (status.state === 'error') {
    return status.error ?? 'Compaction failed.'
  }
  // 'done'
  const result = status.result
  if (!result) {
    return 'Compaction finished.'
  }
  if (result.compacted === false) {
    return 'Nothing to compact — this thread was already small.'
  }
  const before = result.contextUsageBefore?.usedTokens
  const after = result.contextUsageAfter?.usedTokens
  if (result.compacted && typeof before === 'number' && typeof after === 'number') {
    return `Compacted — ${formatCount(before)} → ${formatCount(after)} tokens.`
  }
  return 'Compacted.'
}

export function ThreadCompactControl({ threadId }: { threadId: string }) {
  const [status, setStatus] = useState<CompactStatus | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const threadIdRef = useRef(threadId)
  threadIdRef.current = threadId

  const busy = requesting || status?.state === 'pending' || status?.state === 'running'

  // Seed the real status on mount/thread change, rather than assuming idle --
  // a compaction started from another tab (or by someone else) is still
  // running from this one's point of view too.
  useEffect(() => {
    let current = true
    getGroupChatThreadCompactStatus({ data: threadId }).then((s) => {
      if (current) {
        setStatus(s)
      }
    })
    return () => {
      current = false
    }
  }, [threadId])

  useEffect(() => {
    if (status?.state !== 'pending' && status?.state !== 'running') {
      return
    }
    const timer = setInterval(() => {
      getGroupChatThreadCompactStatus({ data: threadIdRef.current }).then(setStatus)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [status?.state])

  async function onCompact() {
    setRefusal(null)
    setRequesting(true)
    try {
      const ack = await compactGroupChatThread({ data: threadId })
      setStatus({ sessionKey: ack.sessionKey, state: ack.state })
    } catch (err) {
      // A membership/agent-removed refusal crosses as a thrown error rather
      // than data (see compactGroupChatThread's own comment) -- read it the
      // same way the rest of group-chats does: name+code survive seroval,
      // instanceof does not.
      setRefusal(groupChatAccessMessage(err) ?? 'That thread could not be compacted.')
    } finally {
      setRequesting(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type='button'
          size='icon'
          variant='ghost'
          aria-label='Compact thread'
          className='relative inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
        >
          {busy ? <Loader2 className='size-4 animate-spin' /> : <Shrink className='size-4' />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' side='top' className='w-64 text-xs'>
        <p className='text-foreground'>{refusal ?? statusLabel(status)}</p>
        {!busy && !refusal ? (
          <Button type='button' size='sm' variant='outline' className='mt-2 w-full' onClick={() => void onCompact()}>
            Compact thread
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
