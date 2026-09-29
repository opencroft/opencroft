'use client'

import { useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { Flex } from 'ui/layout/flex'
import { SpaceIconPicker } from 'ui/spaces/space-icon-picker'

import { fileToAvatarDataUrl } from '@/app/_authed/(settings)/_lib/avatar-image'
import { setSpaceIcon } from '@/app/_authed/(space)/_server/actions'

/**
 * The Icon block of the space settings page: a preset picked in the kit's
 * picker, or an uploaded file re-encoded to a small square data URL client-side
 * (same pipeline as account avatars). Either way the value is stored on the
 * space row.
 */
export function SpaceIconSettings({ spaceSlug, initialIcon }: { spaceSlug: string; initialIcon: string }) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [icon, setIcon] = useState(initialIcon)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function save(next: string) {
    setError(undefined)
    setPending(true)
    try {
      await setSpaceIcon({ data: { slug: spaceSlug, icon: next } })
      setIcon(next)
      // The title bar's space selector reads the layout loader's spaces — refresh it.
      router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The icon could not be saved.')
    } finally {
      setPending(false)
    }
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset so picking the same file again still fires a change event.
    event.target.value = ''
    if (!file) {
      return
    }
    setError(undefined)
    setPending(true)
    try {
      const dataUrl = await fileToAvatarDataUrl(file)
      await save(dataUrl)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file could not be read as an image.')
      setPending(false)
    }
  }

  return (
    <Flex withGaps className='w-full'>
      <h2 className='text-base font-semibold'>Icon</h2>
      <SpaceIconPicker
        value={icon}
        onChange={save}
        onUpload={() => fileInput.current?.click()}
        pending={pending}
        error={error}
      />
      <input
        ref={fileInput}
        type='file'
        accept='image/png,image/jpeg,image/webp'
        className='hidden'
        onChange={handleFile}
      />
    </Flex>
  )
}
