'use client'

import { useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { Button } from 'ui/button'
import { Flex } from 'ui/layout/flex'

import { SpaceIcon } from '@/app/_authed/(space)/_components/space-icon'
import { setSpaceIcon } from '@/app/_authed/(space)/_server/actions'
import { fileToAvatarDataUrl } from '@/app/_authed/(settings)/_lib/avatar-image'

/**
 * The Icon block of the space settings page. Re-encodes the picked file to a
 * small square data URL client-side (same pipeline as account avatars) and
 * stores it on the space row.
 */
export function SpaceIconSettings({ spaceSlug, initialIcon }: { spaceSlug: string; initialIcon: string | null }) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [icon, setIcon] = useState<string | null>(initialIcon)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>()

  async function save(next: string | null) {
    setError(undefined)
    setPending(true)
    try {
      await setSpaceIcon({ data: { slug: spaceSlug, icon: next } })
      setIcon(next)
      // The sidebar selector reads the layout loader's spaces — refresh it.
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
      <Flex row withGaps align='center'>
        <SpaceIcon icon={icon} className='size-16' />
        <Flex row withGaps>
          <Button variant='outline' size='sm' disabled={pending} onClick={() => fileInput.current?.click()}>
            Upload
          </Button>
          <Button variant='ghost' size='sm' disabled={pending || !icon} onClick={() => save(null)}>
            Remove
          </Button>
        </Flex>
      </Flex>
      {error && <p className='text-sm text-destructive'>{error}</p>}
      <input ref={fileInput} type='file' accept='image/png,image/jpeg,image/webp' className='hidden' onChange={handleFile} />
    </Flex>
  )
}
