import { createFileRoute, notFound, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { AdminUserAccess } from 'ui/admin/admin-user-access'
import { AdminUserEdit } from 'ui/admin/admin-user-edit'
import { AdminUserForm } from 'ui/admin/admin-user-form'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import { ROLE_OPTIONS, roleLabel, roleValue } from '@/app/(settings)/_lib/roles'
import { deleteUser, getUser, setUserDisabled, updateUser } from '@/app/(settings)/_server/admin-users-actions'

export const Route = createFileRoute('/(settings)/settings_/users_/$userId')({
  loader: async ({ params }) => {
    const user = await getUser({ data: params.userId })
    if (!user) {
      throw notFound()
    }
    return { user }
  },
  component: EditUserPage,
})

function EditUserPage() {
  const { user } = Route.useLoaderData()
  const { userId } = Route.useParams()
  const navigate = useNavigate()

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
      navigate({ to: '/settings/users' })
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
      navigate({ to: '/settings/users' })
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : 'The account could not be deleted.')
      setDeleting(false)
    }
  }

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
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
      </ScrollContent>
    </ScrollPage>
  )
}
