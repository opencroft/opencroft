'use client'

import { Flex } from 'ui/layout/flex'
import { CommandBar, CommandBarMenu } from '@/app/(dashboard)/_canvas/command-bar'
import { OverlayProvider, useOverlay } from '@/app/(dashboard)/_canvas/overlay-context'
import { AgentChat, AgentChatInput, useAgentSession } from '@/app/(openclaw)/_components/agent-chat'
import type { OpenclawSession } from '@/app/(openclaw)/_server/actions'
import { ChatArea, ChatBar, ChatContent } from '@/components/experimental/chat'

interface Props {
  session: OpenclawSession
}

export function SessionView({ session: sessionInfo }: Props) {
  const title = sessionInfo.title ?? shortKey(sessionInfo.key)
  return (
    <Flex expanded className='min-h-0 min-w-0'>
      <SessionHeader title={title} sessionKey={sessionInfo.key} />
      <OverlayProvider>
        <SessionBody sessionKey={sessionInfo.key} title={title} />
      </OverlayProvider>
    </Flex>
  )
}

function SessionBody({ sessionKey, title }: { sessionKey: string; title: string }) {
  const session = useAgentSession(sessionKey)
  const { slots } = useOverlay()
  return (
    <>
      <AgentChatInput session={session} placeholder={`Message ${title}…`} />
      <ChatArea>
        <ChatContent compact>
          <AgentChat session={session} />
          {slots.content}
        </ChatContent>
        <ChatBar compact>
          <div className='w-full relative'>
            {slots.menu && (
              <div className='absolute bottom-full left-0 right-0 mb-2 z-20'>
                <CommandBarMenu>{slots.menu}</CommandBarMenu>
              </div>
            )}
            {slots.bar && <CommandBar>{slots.bar}</CommandBar>}
          </div>
        </ChatBar>
      </ChatArea>
    </>
  )
}

function SessionHeader({ title, sessionKey }: { title: string; sessionKey: string }) {
  return (
    <Flex row align='center' className='gap-2 border-b px-4 py-2.5'>
      <span className='text-sm font-medium'>{title}</span>
      <code className='text-xs text-muted-foreground truncate'>{sessionKey}</code>
    </Flex>
  )
}

function shortKey(key: string): string {
  const parts = key.split(':')
  return parts.slice(-1)[0] ?? key
}
