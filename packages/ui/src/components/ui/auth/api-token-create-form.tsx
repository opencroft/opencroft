'use client'

import { useId } from 'react'

import { Button } from 'ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'
import { NativeSelect, NativeSelectOption } from 'ui/components/ui/native-select'

export interface ApiTokenExpiryOption {
  value: string
  label: string
}

export interface ApiTokenCreateFormProps {
  name: string
  onNameChange: (value: string) => void
  // The lifetimes on offer, in the order shown. Omitted, the form has no expiry
  // field and the lifetime is the host's alone. Which lifetimes exist -- and
  // whether "never" is one of them -- is the host's to decide.
  expiryOptions?: ApiTokenExpiryOption[]
  // The chosen option's value.
  expiry?: string
  onExpiryChange?: (value: string) => void
  // Reports that the user asked to create the token. The form validates nothing
  // and generates no secret -- the host creates the token and feeds the value
  // into the reveal that follows.
  onSubmit: () => void
  // Message under the name field. Displayed, not decided.
  nameError?: string
  // A whole-form failure -- a rejected create, a server that did not answer.
  error?: string
  // The token is being created: the submit goes inert and says so. The host
  // swaps this form for the reveal once the secret comes back.
  submitting?: boolean
  className?: string
}

// The create half of the API token flow, with no page frame around it: name the
// token, pick its lifetime when the host offers a choice, then create it. Just
// the form -- the one-time secret reveal that follows is its own component,
// because that moment is a different design problem from a labelled input.
//
// Fully controlled and free of the stack it came from: no form library, no
// router, no auth client. Values arrive as props, every outcome leaves as a
// callback, and no secret is ever generated here.
export function ApiTokenCreateForm({
  name,
  onNameChange,
  expiryOptions,
  expiry,
  onExpiryChange,
  onSubmit,
  nameError,
  error,
  submitting,
  className,
}: ApiTokenCreateFormProps) {
  const nameId = useId()
  const expiryId = useId()

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor={nameId}>Token name</FieldLabel>
          <Input
            id={nameId}
            name='name'
            placeholder='e.g. CI deploy token'
            autoComplete='off'
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => onNameChange(event.target.value)}
          />
          <FieldError>{nameError}</FieldError>
        </Field>

        {expiryOptions ? (
          <Field>
            <FieldLabel htmlFor={expiryId}>Expires</FieldLabel>
            <NativeSelect
              id={expiryId}
              name='expiry'
              value={expiry}
              onChange={(event) => onExpiryChange?.(event.target.value)}
            >
              {expiryOptions.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        ) : null}

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          <Button type='submit' disabled={submitting}>
            {submitting ? 'Creating…' : 'Create token'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
