'use client'

import { useRouter } from '@tanstack/react-router'
import { Bot, KeyRound, MessageSquare, RotateCw } from 'lucide-react'
import { useState, useTransition } from 'react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'
import { MenuLayout } from 'ui/layout/menulayout'
import { Separator } from 'ui/separator'

import { SessionView } from '@/app/(openclaw)/_components/session-view'
import type { OpenclawAgent, OpenclawSession, OpenclawState } from '@/app/(openclaw)/_server/actions'
import { cn } from '@/lib/utils'

interface Props {
  state: OpenclawState
}

export function OpenclawView({ state }: Props) {
  if (state.status === 'needs-pairing') {
    return <PairingRequired state={state} />
  }
  return <SessionsView agents={state.agents} />
}

function SessionsView({ agents }: { agents: OpenclawAgent[] }) {
  const [selected, setSelected] = useState<OpenclawSession | null>(null)

  return (
    <MenuLayout
      isOpened={!!selected}
      onClosed={() => setSelected(null)}
      menu={<AgentList agents={agents} selectedKey={selected?.key ?? null} onSelect={setSelected} />}
    >
      {selected ? <SessionView session={selected} /> : <EmptyState />}
    </MenuLayout>
  )
}

function AgentList({
  agents,
  selectedKey,
  onSelect,
}: {
  agents: OpenclawAgent[]
  selectedKey: string | null
  onSelect: (s: OpenclawSession) => void
}) {
  return (
    <Flex withPadding className='gap-3'>
      {agents.map((agent, i) => (
        <div key={agent.agentId}>
          {i > 0 && <Separator className='my-2' />}
          <AgentHeader agent={agent} />
          {agent.sessions.length === 0 && <div className='px-3 py-2 text-xs text-muted-foreground'>no sessions</div>}
          {agent.sessions.map((session) => (
            <SessionRow
              key={session.key}
              session={session}
              active={selectedKey === session.key}
              onClick={() => onSelect(session)}
            />
          ))}
        </div>
      ))}
    </Flex>
  )
}

function AgentHeader({ agent }: { agent: OpenclawAgent }) {
  return (
    <Flex row align='center' className='gap-2 px-3 py-2 text-sm'>
      <Bot className='h-4 w-4 text-muted-foreground shrink-0' />
      <span className='font-medium'>{agent.name}</span>
      {agent.isDefault && <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>default</span>}
      <span className='ml-auto text-xs text-muted-foreground'>
        {agent.sessions.length} / {agent.sessionCount}
      </span>
    </Flex>
  )
}

function SessionRow({ session, active, onClick }: { session: OpenclawSession; active: boolean; onClick: () => void }) {
  const title = session.title ?? shortKey(session.key)
  return (
    <Flex
      row
      align='center'
      className={cn(
        'gap-2 px-3 py-2 rounded-md cursor-pointer text-sm',
        active ? 'bg-accent font-medium' : 'hover:bg-accent/50',
      )}
      onClick={onClick}
    >
      <MessageSquare className='h-3.5 w-3.5 text-muted-foreground shrink-0' />
      <Flex className='min-w-0 gap-0.5'>
        <span className='truncate'>{title}</span>
        {session.lastMessage && <span className='truncate text-xs text-muted-foreground'>{session.lastMessage}</span>}
      </Flex>
      <span className='ml-auto text-xs text-muted-foreground shrink-0'>{formatAge(session.updatedAt)}</span>
    </Flex>
  )
}

function EmptyState() {
  return (
    <Flex expanded align='center' justify='center' className='text-muted-foreground text-sm'>
      select a session
    </Flex>
  )
}

type PairingState = Extract<OpenclawState, { status: 'needs-pairing' }>

function PairingRequired({ state }: { state: PairingState }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const refresh = () => startTransition(() => router.invalidate())

  return (
    <Flex expanded align='center' justify='center' withPadding>
      <Flex className='max-w-lg gap-5 text-sm'>
        <Flex row align='center' className='gap-2 text-base font-semibold'>
          <KeyRound className='h-5 w-5' />
          This app isn&apos;t approved yet
        </Flex>
        <p className='text-muted-foreground'>
          OpenCroft connected to OpenClaw and asked for permission. OpenClaw needs to approve this app once — it will
          then remember it.
        </p>

        <div className='font-medium'>How to approve</div>
        <ol className='flex flex-col gap-3'>
          <Step n={1} title='Open OpenClaw'>
            On the computer running OpenClaw, open the OpenClaw app.
          </Step>
          <Step n={2} title='Find the pending request'>
            Go to <b>Devices</b>. You&apos;ll see a request from this app with the ID below. Click <b>Approve</b>.
            <ApprovalDetails state={state} />
          </Step>
          <Step n={3} title='Come back here'>
            <Button size='sm' onClick={refresh} disabled={isPending} className='mt-1.5'>
              <RotateCw className={cn('h-3.5 w-3.5', isPending && 'animate-spin')} />
              Check now
            </Button>
          </Step>
        </ol>

        <details className='text-xs text-muted-foreground'>
          <summary className='cursor-pointer'>Details</summary>
          <code className='block mt-2 text-foreground break-all'>{state.reason}</code>
        </details>
      </Flex>
    </Flex>
  )
}

function ApprovalDetails({ state }: { state: PairingState }) {
  return (
    <Flex className='mt-2 gap-1.5 text-xs'>
      <IdRow label='Device ID' value={state.deviceId} />
      {state.requestId && <IdRow label='Request ID' value={state.requestId} />}
    </Flex>
  )
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <Flex row align='center' className='gap-2'>
      <span className='text-muted-foreground w-20 shrink-0'>{label}</span>
      <code className='text-foreground break-all'>{value}</code>
    </Flex>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className='flex gap-3'>
      <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium'>
        {n}
      </span>
      <div className='flex flex-col gap-1 pt-0.5'>
        <div className='font-medium'>{title}</div>
        <div className='text-muted-foreground'>{children}</div>
      </div>
    </li>
  )
}

function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) {
    return 'now'
  }
  if (min < 60) {
    return `${min}m`
  }
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    return `${hr}h`
  }
  return `${Math.floor(hr / 24)}d`
}
