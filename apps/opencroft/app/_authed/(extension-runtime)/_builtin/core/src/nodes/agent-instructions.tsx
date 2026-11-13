import { invoke } from '@opencroft/client/actions'
import { Markdown, MarkdownEditor } from '@opencroft/client/markdown'
import { TerminalRef } from '@opencroft/client/terminal'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Flex,
  ScrollArea,
} from '@opencroft/client/ui'
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import type { AgentData } from './agent'
import { useSharedInstructions } from './use-shared-instructions'

// What agent.readInstructions answers (the host's HostAgentInstructions).
interface InstructionFile {
  role: 'shared' | 'agent' | 'system-prompt'
  path?: string
  place?: string
  sharedWith?: string[]
  rereads?: 'turn' | 'session'
  text: string
  version?: number
}

interface AgentInstructions {
  files: InstructionFile[]
  chats: { id: string; name: string }[]
}

// How long the fields that move the files (harness, container, name) settle before they are read again.
const REREAD_DELAY_MS = 400

const listFormat = new Intl.ListFormat('en', { type: 'conjunction' })

/**
 * The agent's instruction texts, one editor per file its harness reads: the
 * shared text of its place first, then its own; or the Custom harness's
 * system prompt. Every editor writes the agent dialect, which keeps the text
 * as typed, because the harness reads the file raw.
 */
export function AgentInstructionsTab({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string
  data: AgentData
  updateData: (p: Partial<AgentData>) => void
}) {
  const { instructions, error, retry } = useAgentInstructions(nodeId, data)
  const shared = instructions?.files.find((file) => file.role === 'shared')
  const own = instructions?.files.find((file) => file.role === 'agent')
  const systemPrompt = instructions?.files.some((file) => file.role === 'system-prompt')

  return (
    <ScrollArea className='h-full'>
      <Flex withGaps className='p-1'>
        {error ? (
          <Field>
            <FieldError className='text-xs'>The instruction files could not be read: {error}</FieldError>
            <Flex row>
              <Button size='sm' variant='outline' onClick={retry}>
                Try again
              </Button>
            </Flex>
          </Field>
        ) : !instructions ? (
          <p className='text-xs text-muted-foreground'>Loading instructions…</p>
        ) : instructions.files.length === 0 ? (
          <p className='text-xs text-muted-foreground'>
            This harness keeps its own instruction files. OpenCroft doesn't manage them.
          </p>
        ) : null}
        {shared?.path ? (
          // One editor per agent and place: its saves name the place it was opened on.
          <SharedInstructionsField key={`${nodeId}\u0000${shared.place}`} nodeId={nodeId} file={shared} />
        ) : null}
        {own?.path ? (
          <InstructionsField
            heading="This agent's instructions"
            path={own.path}
            rereads={own.rereads}
            value={data.workspaceInstructions ?? ''}
            onChange={(workspaceInstructions) => updateData({ workspaceInstructions })}
          />
        ) : null}
        {systemPrompt ? (
          <Field>
            <FieldLabel className='text-xs'>System prompt</FieldLabel>
            <AgentTextEditor
              value={data.systemPrompt ?? ''}
              onChange={(text) => updateData({ systemPrompt: text })}
              placeholder='Custom harness system prompt…'
            />
            <FieldDescription className='text-xs'>The agent reads an edit at its next message.</FieldDescription>
          </Field>
        ) : null}
        {instructions ? <OtherSources chats={instructions.chats} /> : null}
      </Flex>
    </ScrollArea>
  )
}

// A read's outcome: the texts, or why they could not be read; neither while the first read is out.
type InstructionsRead = { instructions: AgentInstructions | null; error: string }

/** The agent's texts, read again when a field that moves its files changes or `retry` is called. */
function useAgentInstructions(nodeId: string, data: AgentData): InstructionsRead & { retry: () => void } {
  const [read, setRead] = useState<InstructionsRead>({ instructions: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  const placement = [data.adapterId ?? '', data.name ?? '', data.terminal ?? '', data.terminalFolder ?? ''].join(
    '\u0000',
  )
  // placement and attempt are triggers, not inputs: the server reads the fields from the node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placement and attempt are only re-read triggers, the effect does not read them
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      invoke<AgentInstructions>('agent.readInstructions', nodeId)
        .then((instructions) => {
          if (active) {
            setRead({ instructions, error: '' })
          }
        })
        .catch((e: unknown) => {
          if (active) {
            setRead({ instructions: null, error: e instanceof Error ? e.message : String(e) })
          }
        })
    }, REREAD_DELAY_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [nodeId, placement, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...read, retry }
}

function whenSeen(rereads: InstructionFile['rereads']): string {
  return rereads === 'turn'
    ? 'The agent reads an edit at its next turn.'
    : 'The agent reads an edit at its next session, and in an open thread at its next message.'
}

/** `CLAUDE.md · /agents/support-bot`: the file's name, then the directory it is in. */
function FileName({ path }: { path: string }) {
  const slash = path.lastIndexOf('/')
  return (
    // max-w-full: in the label's column the span is as wide as its text, so truncate needs a cap to clip at.
    <span className='max-w-full truncate font-normal text-muted-foreground'>
      <span className='font-mono text-foreground'>{path.slice(slash + 1)}</span> ·{' '}
      <span className='font-mono'>{path.slice(0, slash) || '/'}</span>
    </span>
  )
}

function AgentTextEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (text: string) => void
  placeholder?: string
}) {
  return (
    // The default look, toolbar on top, as a task's description: its own box is the field's one border.
    <MarkdownEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder ?? 'Write instructions…'}
      className='min-h-40'
      // The harness reads the file as written: lines and `<word>` stay as typed.
      dialect='agent'
    />
  )
}

function InstructionsField({
  heading,
  path,
  rereads,
  value,
  onChange,
}: {
  heading: string
  path: string
  rereads: InstructionFile['rereads']
  value: string
  onChange: (text: string) => void
}) {
  return (
    <Field>
      <FieldLabel className='flex-col items-start gap-0.5 text-xs'>
        <span>{heading}</span>
        <FileName path={path} />
      </FieldLabel>
      <AgentTextEditor value={value} onChange={onChange} />
      <FieldDescription className='text-xs'>{whenSeen(rereads)}</FieldDescription>
    </Field>
  )
}

// An agent runs through a terminal, and every agent on it shares this text.
function placeHeading(place: string | undefined): ReactNode {
  const terminal = place?.startsWith('terminal:') ? place.slice('terminal:'.length) : null
  return terminal ? (
    <>
      Shared by every agent on terminal <TerminalRef target={terminal} />
    </>
  ) : (
    'Shared by every agent here'
  )
}

function SharedInstructionsField({ nodeId, file }: { nodeId: string; file: InstructionFile }) {
  const read = useMemo(() => ({ text: file.text, version: file.version ?? 0 }), [file.text, file.version])
  const shared = useSharedInstructions(nodeId, file.place ?? '', read)
  const readers = file.sharedWith ?? []

  return (
    <Field>
      <FieldLabel className='flex-col items-start gap-0.5 text-xs'>
        <span>{placeHeading(file.place)}</span>
        <FileName path={file.path ?? ''} />
      </FieldLabel>
      <AgentTextEditor value={shared.value} onChange={shared.onChange} />
      <FieldDescription className='text-xs'>
        {readers.length > 0 ? `Read by ${listFormat.format(readers)}. ` : ''}
        {whenSeen(file.rereads)}
        {shared.saving ? ' Saving…' : ''}
      </FieldDescription>
      {shared.error ? <FieldError className='text-xs'>Not saved: {shared.error}</FieldError> : null}
      {shared.conflict ? (
        <Alert variant='destructive'>
          <AlertTitle>Someone else saved the shared text first</AlertTitle>
          <AlertDescription>
            <p>
              Your edit is not saved.{' '}
              {shared.conflict.updatedBy ? `${shared.conflict.updatedBy} saved this text:` : 'The text there now:'}
            </p>
            <div className='max-h-48 w-full overflow-auto rounded-md border p-2 text-foreground'>
              {shared.conflict.text ? (
                <Markdown text={shared.conflict.text} lineBreaks />
              ) : (
                <span className='italic text-muted-foreground'>Empty</span>
              )}
            </div>
            <Flex row withGaps>
              <Button size='sm' variant='outline' onClick={shared.takeTheirs}>
                Use this text
              </Button>
              <Button size='sm' variant='outline' onClick={shared.keepMine}>
                Save mine over it
              </Button>
            </Flex>
          </AlertDescription>
        </Alert>
      ) : null}
    </Field>
  )
}

/**
 * The agent's other instructions, which reach it in its threads' messages
 * rather than in a file: the topic and pinned notes of each chat it is in.
 */
function OtherSources({ chats }: { chats: AgentInstructions['chats'] }) {
  return (
    <p className='text-xs text-muted-foreground'>
      {chats.length === 0
        ? 'Also given to the agent in its threads: no chat topics or pinned notes, as it is in no chat.'
        : 'Also given to the agent in its threads: the topic and pinned notes of '}
      {chats.map((chat, index) => (
        <Fragment key={chat.id}>
          {index > 0 ? (index === chats.length - 1 ? ' and ' : ', ') : ''}
          <a className='underline' href={`/group-chats/${chat.id}`}>
            {chat.name}
          </a>
        </Fragment>
      ))}
      {chats.length > 0 ? '.' : ''}
    </p>
  )
}
