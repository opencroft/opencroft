'use client'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface AccountAvatarProps {
  // Current avatar image; null/undefined or an empty string falls back to a
  // person icon inside AgentAvatar.
  avatar?: string | null
  // Alt text / fallback identity for the avatar.
  name?: string
  // The user asked to replace the image. The host owns the file picker and
  // the upload; this only reports the request.
  onReplace: () => void
  // The user asked to remove the current image. Omit when removal is not
  // offered (no image is set, or the host forbids it).
  onRemove?: () => void
  // An upload is in flight: replace goes inert and says so.
  pending?: boolean
  className?: string
}

// The avatar setting for a signed-in person, with no frame around it. Mirrors
// the agent avatar setting: the `lg` AgentAvatar shows the current image (or a
// person fallback when nothing is set), with replace and remove beside it. A
// person's avatar needs nothing an agent's does, so the preview reuses
// [Agent Avatar](/dashboard/design-kit) rather than introducing a second one.
//
// Presentation only: it owns no file picker and no storage -- the host picks
// the file on `onReplace`, persists it, and feeds the resulting URL back in as
// `avatar`.
export function AccountAvatar({
  avatar,
  name,
  onReplace,
  onRemove,
  pending,
  className,
}: AccountAvatarProps) {
  const hasAvatar = Boolean(avatar)

  return (
    <div className={cn('flex flex-col gap-4 sm:flex-row sm:items-center', className)}>
      <AgentAvatar avatar={avatar} name={name} size='lg' />
      <div className='flex flex-wrap gap-2'>
        <Button type='button' variant='outline' onClick={onReplace} disabled={pending}>
          {pending ? 'Uploading…' : hasAvatar ? 'Replace' : 'Upload'}
        </Button>
        {onRemove ? (
          <Button
            type='button'
            variant='ghost'
            onClick={onRemove}
            disabled={pending || !hasAvatar}
          >
            Remove
          </Button>
        ) : null}
      </div>
    </div>
  )
}
