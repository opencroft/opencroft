import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AdminUserForm } from 'ui/admin/admin-user-form'
import { Button } from 'ui/button'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { ROLE_OPTIONS, roleValue } from '@/app/_authed/(settings)/_lib/roles'
import { createUser } from '@/app/_authed/(settings)/_server/admin-users-actions'

export const Route = createFileRoute('/_authed/(settings)/settings_/users_/new')({
  component: NewUserPage,
})

// Better Auth requires a password at creation, and there is no "invite, they
// set their own" flow on this instance — that needs email delivery, which
// does not exist here either. A random one is generated so the admin does
// not have to invent it, shown exactly once after creation (the admin
// relays it to the new person out of band), then held only in this
// component's state — never logged, never sent anywhere.
function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('')
}

function NewUserPage() {
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState(ROLE_OPTIONS[1] ?? 'Member')
  const [nameError, setNameError] = useState<string>()
  const [emailError, setEmailError] = useState<string>()
  const [error, setError] = useState<string>()
  const [submitting, setSubmitting] = useState(false)
  const [created, setCreated] = useState<{ email: string; password: string }>()

  const handleSubmit = async () => {
    setNameError(undefined)
    setEmailError(undefined)
    setError(undefined)
    let invalid = false
    if (!name.trim()) {
      setNameError('A name is required.')
      invalid = true
    }
    if (!email.trim()) {
      setEmailError('An email address is required.')
      invalid = true
    }
    if (invalid) {
      return
    }
    setSubmitting(true)
    const password = generateTemporaryPassword()
    try {
      await createUser({
        data: { name: name.trim(), email: email.trim(), password, role: roleValue(role) },
      })
      setCreated({ email: email.trim(), password })
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The account could not be created.')
    } finally {
      setSubmitting(false)
    }
  }

  if (created) {
    return (
      <ScrollPage>
        <ScrollContent className='p-4'>
          <div className='mx-auto flex w-full max-w-3xl flex-col gap-4'>
            <h1 className='text-lg font-semibold'>Account created</h1>
            <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-4'>
              <p className='text-sm'>
                This is the only time this password is shown. Share it with{' '}
                <span className='font-medium'>{created.email}</span> yourself — there is no email on this instance to
                send it for you.
              </p>
              <p className='mt-3 select-all rounded bg-background px-3 py-2 font-mono text-sm'>{created.password}</p>
            </div>
            <div>
              <Button type='button' onClick={() => navigate({ to: '/settings/users' })}>
                Done
              </Button>
            </div>
          </div>
        </ScrollContent>
      </ScrollPage>
    )
  }

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
        <div className='mx-auto w-full max-w-3xl'>
          <h1 className='mb-6 text-lg font-semibold'>Add user</h1>
          <AdminUserForm
            mode='create'
            name={name}
            onNameChange={setName}
            email={email}
            onEmailChange={setEmail}
            role={role}
            onRoleChange={setRole}
            roleOptions={ROLE_OPTIONS}
            onSubmit={handleSubmit}
            nameError={nameError}
            emailError={emailError}
            error={error}
            submitting={submitting}
          />
        </div>
      </ScrollContent>
    </ScrollPage>
  )
}
