'use client'

import { useId } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export interface CreateGroupChatFormProps {
  topic: string
  onTopicChange: (value: string) => void
  // Reports that the user asked to create. The form validates nothing and
  // calls nothing -- what happens next, and what comes back, is the host's.
  onSubmit: () => void
  submitting?: boolean
  // A whole-form failure -- a rejected create, an unreachable server.
  // Displayed, not decided.
  error?: string
  className?: string
}

// The form that creates a group chat.
//
// A topic and a submit, and nothing else. The creator becomes the first member
// automatically, so there is no member step here; members and threads are
// added afterwards from the chat itself. Asking for them up front would invent
// a multi-step creation that nothing behind this supports.
//
// Fully controlled and free of the stack it came from -- no form library, no
// router, no client. The topic comes in as a prop and every outcome leaves as
// a callback.
export function CreateGroupChatForm({
  topic,
  onTopicChange,
  onSubmit,
  submitting,
  error,
  className,
}: CreateGroupChatFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const topicId = useId()

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={topicId}>Topic</FieldLabel>
          <Input
            id={topicId}
            name='topic'
            value={topic}
            placeholder='What is this group chat about?'
            autoComplete='off'
            aria-invalid={error ? true : undefined}
            onChange={(event) => onTopicChange(event.target.value)}
          />
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          {/* Inert only while a create is in flight. Whether an empty topic may
              be submitted is the host's rule, reported back through `error` --
              the same contract the other forms in this kit keep. */}
          <Button type='submit' disabled={submitting}>
            {submitting ? 'Creating…' : 'Create group chat'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
