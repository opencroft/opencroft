'use client';

import { CommandBar, CommandBarMenu } from '@/app/(dashboard)/_canvas/command-bar';
import { OverlayContext, useOverlayState } from '@/app/(dashboard)/_canvas/overlay-context';
import { OpenclawSession } from '@/app/(openclaw)/openclaw/actions';
import { AgentChat, AgentChatInput, useAgentSession } from '@/app/(openclaw)/openclaw/agent-chat';
import { ChatArea, ChatBar, ChatContent } from '@/components/experimental/chat';
import { Flex } from '@/components/ui/layout/flex';

interface Props {
  session: OpenclawSession;
}

export function SessionView({ session: sessionInfo }: Props) {
  const session = useAgentSession(sessionInfo.key);
  const slots = useOverlayState();
  const title = sessionInfo.title ?? shortKey(sessionInfo.key);
  return (
    <Flex expanded className='min-h-0 min-w-0'>
      <SessionHeader title={title} sessionKey={sessionInfo.key} />
      <OverlayContext.Provider value={{ setSlot: slots.setSlot }}>
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
      </OverlayContext.Provider>
    </Flex>
  );
}

function SessionHeader({ title, sessionKey }: { title: string; sessionKey: string }) {
  return (
    <Flex row align='center' className='gap-2 border-b px-4 py-2.5'>
      <span className='text-sm font-medium'>{title}</span>
      <code className='text-xs text-muted-foreground truncate'>{sessionKey}</code>
    </Flex>
  );
}

function shortKey(key: string): string {
  const parts = key.split(':');
  return parts.slice(-1)[0] ?? key;
}
