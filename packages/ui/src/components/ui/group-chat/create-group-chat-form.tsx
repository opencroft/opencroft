'use client'

import { useId } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export interface CreateGroupChatFormProps {
  name: string
  onNameChange: (value: string) => void
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
// A name and a submit, and nothing else. The creator becomes the first member
// automatically, so there is no member step here; members and threads are
// added afterwards from the chat itself. Asking for them up front would invent
// a multi-step creation that nothing behind this supports.
//
// One field, not two, even though a group chat has both a name and a topic:
// asking someone to state a chat's purpose at the moment they know least about
// it buys nothing, and the topic is editable in the chat's own header the
// moment it exists. What the host does with this single string -- naming the
// chat, and seeding its topic from the same value -- is the host's business,
// not something this form claims.
//
// Fully controlled and free of the stack it came from -- no form library, no
// router, no client. The name comes in as a prop and every outcome leaves as
// a callback.
export function CreateGroupChatForm({
  name,
  onNameChange,
  onSubmit,
  submitting,
  error,
  className,
}: CreateGroupChatFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const nameId = useId()

  return (
    <form
      className={className}
      method='post'
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            name='name'
            value={name}
            placeholder='e.g. Q3 launch planning'
            autoComplete='off'
            aria-invalid={error ? true : undefined}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          {/* Inert only while a create is in flight. Whether an empty name may
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
