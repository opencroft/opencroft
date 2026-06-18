'use client'

import { Bot, Loader2, Plug, Settings2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from 'ui/components/ui/button'
import { AdaptivePopup, PopupContent, PopupHeader } from 'ui/components/ui/layout/adaptive-popup'
import { Flex } from 'ui/components/ui/layout/flex'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/components/ui/select'
import { Switch } from 'ui/components/ui/switch'
import { cn } from 'ui/lib/utils'

import { AgentChatInput } from './chat-input'
import { ChatView } from './chat-view'
import { McpServerDialog } from './mcp-form'
import { AgentPresetForm, AgentProfilePicker } from './preset-form'
import { imageToolView, type ToolViewRegistry } from './tool-views'
import { useAgentSession } from './use-agent-session'

export interface AgentChatProps {
  // SSE endpoint streaming session events; delegate the route to
  // `agentEventsResponse`. Defaults to `/api/acp/events`.
  eventsUrl?: string
  // Custom views for specific tools, keyed by tool name. Defaults to rendering
  // a `generate_image` tool's URL result as an inline image.
  toolViews?: ToolViewRegistry
  className?: string
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return String(n)
}

const DEFAULT_TOOL_VIEWS: ToolViewRegistry = { generate_image: imageToolView }

// A complete, self-contained agent chat: a configuration toolbar (profiles,
// preset editor, MCP server, mode, visibility toggles) above a streaming
// transcript with a composer. Drop it in and point it at the SSE route.
export function AgentChat({ eventsUrl, toolViews = DEFAULT_TOOL_VIEWS, className }: AgentChatProps) {
  const session = useAgentSession({ eventsUrl })
  const [showThinking, setShowThinking] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)

  return (
    <Flex className={cn('h-full min-h-0 w-full', className)}>
      {/* Toolbar */}
      <Flex row align='center' withSpacing className='border-b gap-2 flex-wrap'>
        <AdaptivePopup
          open={agentOpen}
          onOpenChange={setAgentOpen}
          trigger={
            <Button variant='outline' size='sm'>
              <Settings2 /> Agent
            </Button>
          }
        >
          <PopupHeader>Agent profile</PopupHeader>
          <PopupContent className='mx-auto w-full max-w-md'>
            <Flex withGaps>
              <AgentProfilePicker
                profiles={session.profiles}
                activeId={session.activeId}
                onSelect={session.switchProfile}
                onCreate={session.newProfile}
                onDelete={session.deleteProfile}
              />
              <AgentPresetForm
                name={session.name}
                onNameChange={session.setName}
                selection={session.selection}
                onSelectionChange={session.updateSelection}
                loadedModels={session.loadedModels}
                loadingModels={session.loadingModels}
                onLoadModels={session.loadModels}
                roles={session.roles}
                roleIds={session.roleIds}
                onRoleIdsChange={session.setRoleIds}
                onSave={async () => {
                  await session.saveProfile()
                  setAgentOpen(false)
                }}
              />
            </Flex>
          </PopupContent>
        </AdaptivePopup>

        <McpServerDialog
          trigger={
            <Button variant='outline' size='sm'>
              <Plug /> MCP
            </Button>
          }
        />

        {session.modes.length > 0 && (
          <Select value={session.currentMode} onValueChange={session.setMode}>
            <SelectTrigger size='sm'>
              <SelectValue placeholder='Mode' />
            </SelectTrigger>
            <SelectContent>
              {session.modes.map((mode) => (
                <SelectItem key={mode.id} value={mode.id}>
                  {mode.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Flex row align='center' className='gap-3 text-xs text-muted-foreground'>
          <label htmlFor='agent-chat-thinking' className='flex items-center gap-1.5 cursor-pointer'>
            <Switch id='agent-chat-thinking' size='sm' checked={showThinking} onCheckedChange={setShowThinking} />
            Thinking
          </label>
          <label htmlFor='agent-chat-tools' className='flex items-center gap-1.5 cursor-pointer'>
            <Switch id='agent-chat-tools' size='sm' checked={showTools} onCheckedChange={setShowTools} />
            Tools
          </label>
        </Flex>

        <div className='flex-1' />

        {session.usage && (
          <span className='text-xs text-muted-foreground tabular-nums' title='Context: tokens in context / window'>
            {formatTokens(session.usage.used)}
            {session.usage.size ? ` / ${formatTokens(session.usage.size)}` : ''} ctx
          </span>
        )}

        <Flex row align='center' className='gap-1.5 text-xs text-muted-foreground'>
          <span className={cn('w-2 h-2 rounded-full', session.sessionId ? 'bg-green-500' : 'bg-muted-foreground/40')} />
          {session.sessionId ? 'Active' : 'No session'}
        </Flex>

        {session.sessionId && (
          <Button variant='ghost' size='icon-sm' onClick={session.clear} title='Clear session'>
            <Trash2 />
          </Button>
        )}

        <Button size='sm' onClick={session.start} disabled={!session.canStart || session.starting}>
          {session.starting ? <Loader2 className='animate-spin' /> : <Bot />} New chat
        </Button>
      </Flex>

      {/* Transcript + composer */}
      <ChatView
        blocks={session.blocks}
        toolViews={toolViews}
        hideThinking={!showThinking}
        hideToolCalls={!showTools}
        turnActive={session.turnActive}
        canFork={session.isNative}
        onFork={session.fork}
        onRespondPermission={session.respondPermission}
        onRespondText={session.respondPermissionText}
        onRespondAsk={session.respondAsk}
        emptyState={
          <>
            <Bot className='size-8 opacity-40' />
            {session.sessionId
              ? 'Send a message to start the conversation.'
              : 'Configure an agent and start a new chat.'}
          </>
        }
        footer={
          <AgentChatInput
            value={session.input}
            onValueChange={session.setInput}
            onSend={session.send}
            busy={session.turnActive}
            onStop={session.stop}
            disabled={!session.sessionId && !session.canStart}
            placeholder={session.sessionId || session.canStart ? 'Message the agent…' : 'Configure an agent to begin'}
          />
        }
      />
    </Flex>
  )
}
