'use client'

import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import { AccountAvatar } from 'ui/auth/account-avatar'
import { AccountPasswordForm } from 'ui/auth/account-password-form'
import { AccountProfile } from 'ui/auth/account-profile'
import { AccountProfileForm } from 'ui/auth/account-profile-form'
import { Spinner } from 'ui/spinner'

import TokenSettings from '@/app/_authed/(settings)/_components/token-settings'
import { fileToAvatarDataUrl } from '@/app/_authed/(settings)/_lib/avatar-image'
import {
  changeEmail,
  changePassword,
  getAccount,
  type OwnAccount,
  updateAvatar,
  updateProfile,
} from '@/app/_authed/(settings)/_server/account-actions'

/**
 * The account screen: avatar, profile, password and API tokens as one panel
 * — the kit's `AccountProfile`. Previously split across a
 * standalone "API Tokens" menu section and an unlinked `/settings/profile`
 * route; the kit designs this as one screen, so the app renders it as one.
 *
 * Each row is the kit's component wired to a server action; this file owns
 * the state and the calls, and none of the presentation.
 */
export default function AccountSettings() {
  const [account, setAccount] = useState<OwnAccount | null>(null)

  useEffect(() => {
    getAccount().then(setAccount)
  }, [])

  if (!account) {
    return (
      <div className='flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground'>
        <Spinner /> Loading account…
      </div>
    )
  }

  return <AccountSettingsForm account={account} />
}

// Split from AccountSettings so the profile/password state can initialise
// straight from `account` -- it only mounts once `account` is loaded, so
// there is no loading-then-syncing step to get wrong.
function AccountSettingsForm({ account }: { account: OwnAccount }) {
  const [image, setImage] = useState(account.image)
  const [avatarPending, setAvatarPending] = useState(false)
  const [avatarError, setAvatarError] = useState<string>()
  // The kit's AccountAvatar owns no file picker by design — it reports that
  // the person asked to replace the picture and leaves choosing one to the
  // host. This is that picker.
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const handlePickAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Cleared immediately so picking the same file twice in a row still fires
    // a change event — otherwise a failed attempt cannot be retried.
    event.target.value = ''
    if (!file) {
      return
    }
    setAvatarError(undefined)
    setAvatarPending(true)
    try {
      const dataUrl = await fileToAvatarDataUrl(file)
      await updateAvatar({ data: dataUrl })
      setImage(dataUrl)
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : 'The picture could not be saved.')
    } finally {
      setAvatarPending(false)
    }
  }

  const handleRemoveAvatar = async () => {
    setAvatarError(undefined)
    setAvatarPending(true)
    try {
      await updateAvatar({ data: null })
      setImage(null)
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : 'The picture could not be removed.')
    } finally {
      setAvatarPending(false)
    }
  }

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
    <AccountProfile
      avatar={
        <div className='flex flex-col gap-2'>
          <AccountAvatar
            avatar={image}
            name={account.name}
            onReplace={() => fileInputRef.current?.click()}
            onRemove={handleRemoveAvatar}
            pending={avatarPending}
          />
          <input ref={fileInputRef} type='file' accept='image/*' className='hidden' onChange={handlePickAvatar} />
          {avatarError ? <p className='text-sm text-destructive'>{avatarError}</p> : null}
        </div>
      }
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
      tokens={<TokenSettings />}
    />
  )
}
