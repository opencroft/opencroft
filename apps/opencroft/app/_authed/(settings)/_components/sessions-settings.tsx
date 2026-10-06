'use client'

import { useEffect, useState, useTransition } from 'react'
import { AgentSessions } from 'ui/settings/agent-sessions'

import { readBackgroundTasks } from '@/app/_authed/(settings)/_lib/read-background-tasks'
import {
  type BackgroundTaskList,
  getSleepMode,
  getYoloMode,
  listBackgroundTasks,
  listLiveSessions,
  updateSleepMode,
  updateYoloMode,
} from '@/app/_authed/(settings)/_server/audit-actions'

// The page is the kit's AgentSessions; what stays here is everything that
// talks to the server: the two mode flags, and the polling that keeps the
// live parts live.

export default function SessionsSettings() {
  const [, startTransition] = useTransition()
  const [yoloEnabled, setYoloEnabled] = useState(false)
  const [yoloSource, setYoloSource] = useState<'env' | 'runtime'>('env')
  const [sleepEnabled, setSleepEnabled] = useState(false)
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof listLiveSessions>>>([])
  // Null until the first read comes back, which the page draws as not read
  // yet rather than as an empty list.
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskList | null>(null)

  useEffect(() => {
    getYoloMode().then(({ enabled, source }) => {
      setYoloEnabled(enabled)
      setYoloSource(source)
    })
  }, [])

  // Sessions, background tasks and the sleep flag re-poll together: the flag
  // can change out-of-band (the marker file is touchable from outside the
  // app), and the lists are only useful live — their whole job is answering
  // "can I restart now", which yesterday's snapshot cannot.
  useEffect(() => {
    let cancelled = false
    const poll = () => {
      listLiveSessions()
        .then((rows) => {
          if (!cancelled) {
            setSessions(rows)
          }
        })
        .catch(() => {})
      readBackgroundTasks(() => listBackgroundTasks()).then((list) => {
        if (!cancelled) {
          setBackgroundTasks(list)
        }
      })
      getSleepMode()
        .then(({ enabled }) => {
          if (!cancelled) {
            setSleepEnabled(enabled)
          }
        })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const onToggleSleep = () => {
    const next = !sleepEnabled
    startTransition(async () => {
      const info = await updateSleepMode({ data: next })
      setSleepEnabled(info.enabled)
    })
  }

  const onToggleYolo = () => {
    const next = !yoloEnabled
    startTransition(async () => {
      await updateYoloMode({ data: next })
      setYoloEnabled(next)
      setYoloSource('runtime')
    })
  }

  return (
    <AgentSessions
      sleepEnabled={sleepEnabled}
      onToggleSleep={onToggleSleep}
      yoloEnabled={yoloEnabled}
      yoloSource={yoloSource}
      onToggleYolo={onToggleYolo}
      sessions={sessions}
      backgroundTasks={backgroundTasks?.tasks ?? null}
      backgroundTasksError={backgroundTasks?.error}
    />
  )
}
