'use client'

import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AdminUserAccess } from 'ui/admin/admin-user-access'
import { AdminUserEdit } from 'ui/admin/admin-user-edit'
import { AdminUserForm } from 'ui/admin/admin-user-form'
import { AdminUsers } from 'ui/admin/admin-users'
import { Button } from 'ui/button'
import { Spinner } from 'ui/spinner'

import { ROLE_OPTIONS, roleLabel, roleValue } from '@/app/_authed/(settings)/_lib/roles'
import {
  createUser,
  deleteUser,
  getSingleAdminWarning,
  getUser,
  listUsers,
  setUserDisabled,
  updateUser,
} from '@/app/_authed/(settings)/_server/admin-users-actions'

// Which screen of the user-administration flow is showing. Local state, not
// URL state: the add and edit flows are transient (a half-filled form is not
// an address anyone can return to), so the section keeps the one address
// /settings?section=users and switching sections resets to the list.
type View = { kind: 'list' } | { kind: 'new' } | { kind: 'edit'; userId: string }

function formatDate(value: string | Date | null): string | undefined {
  if (!value) {
    return undefined
  }
  return new Date(value).toISOString().slice(0, 10)
}

// The kit form deliberately carries no navigation of its own, so the way back
// to the list is the host's to provide.
function BackToUsers({ onClick }: { onClick: () => void }) {
  return (
    <Button type='button' variant='ghost' size='sm' className='self-start' onClick={onClick}>
      <ArrowLeft className='h-4 w-4' />
      Users
    </Button>
  )
}

function UsersListView({ onAdd, onEdit }: { onAdd: () => void; onEdit: (userId: string) => void }) {
  const [data, setData] = useState<{ users: Awaited<ReturnType<typeof listUsers>>; singleAdmin: boolean }>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    Promise.all([listUsers(), getSingleAdminWarning()])
      .then(([users, singleAdmin]) => {
        if (!cancelled) {
          setData({ users, singleAdmin })
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'The user list could not be loaded.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (error) {
    return <p className='mx-auto w-full max-w-3xl text-sm text-destructive'>{error}</p>
  }
  if (!data) {
    return <Spinner className='mx-auto' />
  }

  return (
    <div className='mx-auto flex w-full max-w-3xl flex-col gap-4'>
      {data.singleAdmin ? (
        // The state this banner exists to make visible instead of silent:
        // exactly one administrator, no recovery if that password is lost.
        // See RECOVERY.md for the break-glass procedure — this banner is the
        // thing that should send someone there before they need it.
        <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm'>
          This instance has only one administrator. If that account's password is lost, there is no self-service
          recovery — add a second administrator so you are not the single point of failure.
        </div>
      ) : null}
      <AdminUsers
        users={data.users.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          avatar: user.image,
          role: roleLabel(user.role),
          joinedAt: formatDate(user.createdAt) ?? '',
          lastSeenAt: formatDate(user.lastSeenAt),
          disabled: user.disabled,
        }))}
        onAdd={onAdd}
        onEdit={onEdit}
      />
    </div>
  )
}

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

function NewUserView({ onDone }: { onDone: () => void }) {
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
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-4'>
        <h1 className='text-lg font-semibold'>Account created</h1>
        <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 p-4'>
          <p className='text-sm'>
            This is the only time this password is shown. Share it with{' '}
            <span className='font-medium'>{created.email}</span> yourself — there is no email on this instance to send
            it for you.
          </p>
          <p className='mt-3 select-all rounded bg-background px-3 py-2 font-mono text-sm'>{created.password}</p>
        </div>
        <div>
          <Button type='button' onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className='mx-auto flex w-full max-w-3xl flex-col gap-4'>
      <BackToUsers onClick={onDone} />
      <h1 className='text-lg font-semibold'>Add user</h1>
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
  )
}

function EditUserView({ userId, onDone }: { userId: string; onDone: () => void }) {
  const [user, setUser] = useState<Awaited<ReturnType<typeof getUser>>>()
  const [loadError, setLoadError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    getUser({ data: userId })
      .then((loaded) => {
        if (cancelled) {
          return
        }
        if (loaded) {
          setUser(loaded)
        } else {
          setLoadError('This account no longer exists.')
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'The account could not be loaded.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  if (loadError) {
    return (
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-4'>
        <BackToUsers onClick={onDone} />
        <p className='text-sm text-destructive'>{loadError}</p>
      </div>
    )
  }
  if (!user) {
    return <Spinner className='mx-auto' />
  }
  return <EditUserForm user={user} userId={userId} onDone={onDone} />
}

function EditUserForm({
  user,
  userId,
  onDone,
}: {
  user: NonNullable<Awaited<ReturnType<typeof getUser>>>
  userId: string
  onDone: () => void
}) {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [role, setRole] = useState(roleLabel(user.role))
  const [nameError, setNameError] = useState<string>()
  const [emailError, setEmailError] = useState<string>()
  const [formError, setFormError] = useState<string>()
  const [saving, setSaving] = useState(false)

  const [disabled, setDisabled] = useState(user.disabled)
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [accessError, setAccessError] = useState<string>()

  const handleSubmit = async () => {
    setNameError(undefined)
    setEmailError(undefined)
    setFormError(undefined)
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
    setSaving(true)
    try {
      await updateUser({ data: { userId, name: name.trim(), email: email.trim(), role: roleValue(role) } })
      onDone()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The account could not be updated.')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleDisabled = async () => {
    setAccessError(undefined)
    setToggling(true)
    const next = !disabled
    try {
      await setUserDisabled({ data: { userId, disabled: next } })
      setDisabled(next)
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : 'Sign-in access could not be changed.')
    } finally {
      setToggling(false)
    }
  }

  const handleDelete = async () => {
    // Confirmation is the host's, per the component's own contract. There is
    // no dialog primitive in this pass's scope to build a custom one with, so
    // this is the plain, unstyled version of "are you sure" rather than an
    // invented confirmation screen.
    if (!window.confirm(`Permanently delete ${user.name}'s account? This cannot be undone.`)) {
      return
    }
    setAccessError(undefined)
    setDeleting(true)
    try {
      await deleteUser({ data: userId })
      onDone()
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : 'The account could not be deleted.')
      setDeleting(false)
    }
  }

  return (
    <>
      <div className='mx-auto w-full max-w-3xl'>
        <BackToUsers onClick={onDone} />
      </div>
      <AdminUserEdit
        name={user.name}
        email={user.email}
        avatar={user.image}
        form={
          <AdminUserForm
            mode='edit'
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
            error={formError}
            submitting={saving}
          />
        }
        access={
          <AdminUserAccess
            userName={user.name}
            disabled={disabled}
            onToggleDisabled={handleToggleDisabled}
            onDelete={handleDelete}
            deleting={deleting}
            toggling={toggling}
          />
        }
      />
      {accessError ? <p className='mx-auto mt-4 max-w-3xl text-sm text-destructive'>{accessError}</p> : null}
    </>
  )
}

// User administration as a settings section: the list, with the add and edit
// flows swapped in place of it. The settings page already provides the scroll
// frame every section shares, so nothing here brings its own.
export default function UsersSettings() {
  const [view, setView] = useState<View>({ kind: 'list' })

  if (view.kind === 'new') {
    return <NewUserView onDone={() => setView({ kind: 'list' })} />
  }
  if (view.kind === 'edit') {
    return <EditUserView userId={view.userId} onDone={() => setView({ kind: 'list' })} />
  }
  return <UsersListView onAdd={() => setView({ kind: 'new' })} onEdit={(userId) => setView({ kind: 'edit', userId })} />
}
