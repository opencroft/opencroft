import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AccountPasswordForm } from 'ui/auth/account-password-form'
import { AccountProfile } from 'ui/auth/account-profile'
import { AccountProfileForm } from 'ui/auth/account-profile-form'
import { ScrollContent, ScrollPage } from 'ui/layout/scrollpage'

import {
  changeEmail,
  changePassword,
  getAccount,
  type OwnAccount,
  updateProfile,
} from '@/app/(settings)/_server/account-actions'

export const Route = createFileRoute('/(settings)/settings_/profile')({
  loader: async (): Promise<{ account: OwnAccount }> => {
    const account = await getAccount()
    if (!account) {
      // The root gate already refuses an unauthenticated request before this
      // loader runs; a null account here means the session resolved to
      // nothing between that check and this one (e.g. it just expired).
      throw new Error('Not signed in')
    }
    return { account }
  },
  component: ProfileSettingsPage,
})

function ProfileSettingsPage() {
  const { account } = Route.useLoaderData()

  const [name, setName] = useState(account.name)
  const [nameError, setNameError] = useState<string>()
  const [profileError, setProfileError] = useState<string>()
  const [savingProfile, setSavingProfile] = useState(false)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordError, setPasswordError] = useState<string>()
  const [confirmError, setConfirmError] = useState<string>()
  const [savingPassword, setSavingPassword] = useState(false)

  const handleSaveProfile = async () => {
    setNameError(undefined)
    setProfileError(undefined)
    if (!name.trim()) {
      setNameError('A display name is required.')
      return
    }
    setSavingProfile(true)
    try {
      await updateProfile({ data: name.trim() })
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'The name could not be saved.')
    } finally {
      setSavingProfile(false)
    }
  }

  const handleRequestEmailChange = async () => {
    // No email-composition UI ships in the design kit — AccountProfileForm's
    // own scope is display + a "Change email" button, and the flow that
    // collects the new address is the host's. Without a dedicated dialog
    // component to reach for, `prompt` is the plainest thing that asks one
    // question and reports it back, and email delivery does not exist on
    // this instance regardless, so there is no confirmation step to design
    // around.
    const requested = window.prompt('New email address')
    if (!requested) {
      return
    }
    setProfileError(undefined)
    try {
      await changeEmail({ data: requested })
      window.location.reload()
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'The email could not be changed.')
    }
  }

  const handleSavePassword = async () => {
    setPasswordError(undefined)
    setConfirmError(undefined)
    if (newPassword !== confirmPassword) {
      setConfirmError('Passwords do not match.')
      return
    }
    setSavingPassword(true)
    try {
      await changePassword({ data: { currentPassword, newPassword } })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'The password could not be changed.')
    } finally {
      setSavingPassword(false)
    }
  }

  return (
    <ScrollPage>
      <ScrollContent className='p-4'>
        <AccountProfile
          // Avatar upload has no storage backend to write to on this
          // instance yet (the only existing upload endpoint is the file
          // manager's, wired to SSH/S3/Docker/WSL targets, not image
          // hosting) — a real one is separate scope from "profile edit and
          // password change". The slot is left empty rather than wired to a
          // button that does nothing when pressed.
          profile={
            <AccountProfileForm
              name={name}
              onNameChange={setName}
              email={account.email}
              onRequestEmailChange={handleRequestEmailChange}
              onSubmit={handleSaveProfile}
              nameError={nameError}
              error={profileError}
              submitting={savingProfile}
            />
          }
          password={
            <AccountPasswordForm
              currentPassword={currentPassword}
              onCurrentPasswordChange={setCurrentPassword}
              newPassword={newPassword}
              onNewPasswordChange={setNewPassword}
              confirmPassword={confirmPassword}
              onConfirmPasswordChange={setConfirmPassword}
              onSubmit={handleSavePassword}
              error={passwordError}
              confirmPasswordError={confirmError}
              submitting={savingPassword}
            />
          }
        />
      </ScrollContent>
    </ScrollPage>
  )
}
