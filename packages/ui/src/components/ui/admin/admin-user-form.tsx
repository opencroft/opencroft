'use client'

import { useId } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export type AdminUserFormMode = 'create' | 'edit'

export interface AdminUserFormProps {
  mode?: AdminUserFormMode
  name: string
  onNameChange: (value: string) => void
  email: string
  onEmailChange: (value: string) => void
  role: string
  onRoleChange: (value: string) => void
  // The roles the host offers, as display labels. The host owns the
  // vocabulary and its meaning; this only lists them.
  roleOptions: string[]
  // Reports that the admin asked to save. The form validates nothing and
  // calls nothing -- what happens next is the host's.
  onSubmit: () => void
  // Per-field messages, shown under the field they belong to. Displayed, not
  // decided: the host owns the rules that produced them.
  nameError?: string
  emailError?: string
  roleError?: string
  // A whole-form failure -- a rejected save, a server that did not answer.
  error?: string
  // The save is in flight: the submit goes inert and says so.
  submitting?: boolean
  className?: string
}

// The details form for another person's account -- their name, email and role
// -- with no page frame around it. One form, two uses: `mode="create"` for
// adding a user (the submit reads "Add user") and `mode="edit"` for changing
// one ("Save changes"). Role is a real control even though nothing enforces it
// yet on the server; the field is there, the enforcement is not.
//
// Fully controlled and free of the stack it came from: no form library, no
// router, no auth client. Values arrive as props, every outcome leaves as a
// callback.
export function AdminUserForm({
  mode = 'edit',
  name,
  onNameChange,
  email,
  onEmailChange,
  role,
  onRoleChange,
  roleOptions,
  onSubmit,
  nameError,
  emailError,
  roleError,
  error,
  submitting,
  className,
}: AdminUserFormProps) {
  const nameId = useId()
  const emailId = useId()
  const roleId = useId()
  const creating = mode === 'create'

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
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            name='name'
            placeholder='Ada Lovelace'
            autoComplete='name'
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => onNameChange(event.target.value)}
          />
          <FieldError>{nameError}</FieldError>
        </Field>

        <Field data-invalid={emailError ? true : undefined}>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          <Input
            id={emailId}
            name='email'
            type='email'
            placeholder='ada@example.com'
            autoComplete='email'
            value={email}
            aria-invalid={emailError ? true : undefined}
            onChange={(event) => onEmailChange(event.target.value)}
          />
          <FieldError>{emailError}</FieldError>
        </Field>

        <Field data-invalid={roleError ? true : undefined}>
          <FieldLabel htmlFor={roleId}>Role</FieldLabel>
          <Select value={role} onValueChange={onRoleChange}>
            <SelectTrigger id={roleId} aria-invalid={roleError ? true : undefined}>
              <SelectValue placeholder='Select a role' />
            </SelectTrigger>
            <SelectContent>
              {roleOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError>{roleError}</FieldError>
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          <Button type='submit' disabled={submitting}>
            {submitting
              ? creating
                ? 'Adding…'
                : 'Saving…'
              : creating
                ? 'Add user'
                : 'Save changes'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
