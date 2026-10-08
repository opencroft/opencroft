import { legacy } from '@opencroft/client'

const { InputHandle, NodeFrame, icons } = legacy

// ─── SendMessage Node ────────────────────────────────────────────────

export function SendMessageNode({ selected }: { id: string; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.Send}
      title='Send Message'
      subtitle='JSON { thread, message, queue }'
      selected={selected ?? false}
    >
      <div className='flex flex-col gap-1.5'>
        <InputHandle type='text-stream' id='text-in'>
          <span className='text-[10px] text-muted-foreground'>Text</span>
        </InputHandle>
      </div>
    </NodeFrame>
  )
}

// ─── Inspector ───────────────────────────────────────────────────────

export function SendMessageInspector() {
  return (
    <p className='text-[10px] text-muted-foreground'>
      Accepts JSON <code>{'{ thread, message, queue }'}</code> on the input. <code>thread</code> is a group-chat thread
      reference (<code>group.agent.thread</code>, a whole session key, or a thread id); the message is delivered into
      that thread when the sender is a member of its chat. <code>queue</code> is <code>&quot;wait&quot;</code> or{' '}
      <code>&quot;push&quot;</code>.
    </p>
  )
}

// ─── Handles ─────────────────────────────────────────────────────────

export const SEND_MESSAGE_HANDLES = [
  { id: 'text-in', handleType: 'text-stream', role: 'target' as const, label: 'Text' },
]
