import type { ReactNode } from 'react'

import { cn } from 'cn'

export interface AccountProfileProps {
  // The avatar setting. The host passes a wired AccountAvatar (or its own
  // equivalent); this shell only decides where it sits.
  avatar?: ReactNode
  // The profile form -- typically AccountProfileForm.
  profile?: ReactNode
  // The password-change form -- typically AccountPasswordForm.
  password?: ReactNode
  // The person's own API tokens -- typically ApiTokenList. A self-service
  // account screen is not complete without it; leave it out for a host that
  // surfaces tokens elsewhere.
  tokens?: ReactNode
  className?: string
}

interface RowProps {
  title: string
  description: string
  children?: ReactNode
}

// One labelled row of the settings panel: a fixed-width label and description
// on the left, the setting on the right. On a narrow container the label
// stacks above the setting instead of beside it. The first row loses its top
// padding and the last its bottom, so the panel's edges sit on its content.
function Row({ title, description, children }: RowProps) {
  return (
    <div className='flex flex-col gap-4 py-6 first:pt-0 last:pb-0 md:flex-row md:gap-8'>
      <div className='md:w-64 md:shrink-0'>
        <h2 className='text-sm font-semibold'>{title}</h2>
        <p className='mt-1 text-sm text-muted-foreground'>{description}</p>
      </div>
      <div className='md:min-w-0 md:flex-1'>{children}</div>
    </div>
  )
}

// The account screen: avatar, profile, password and API tokens as labelled
// rows in one continuous panel, divided by rules -- not separate cards floating
// on a page. A host fills each slot with the matching piece, wired to its own
// state; this shell owns no data and calls nothing, it only arranges.
//
// Designed for the minimum width first: the label column is a left rail on
// wide containers and stacks above the setting on narrow ones.
export function AccountProfile({ avatar, profile, password, tokens, className }: AccountProfileProps) {
  return (
    <div className={cn('mx-auto w-full max-w-3xl', className)}>
      <div className='divide-y'>
        {avatar ? (
          <Row title='Avatar' description='The picture shown beside your name.'>
            {avatar}
          </Row>
        ) : null}
        {profile ? (
          <Row title='Profile' description='Your display name and email.'>
            {profile}
          </Row>
        ) : null}
        {password ? (
          <Row title='Password' description='Change the password you sign in with.'>
            {password}
          </Row>
        ) : null}
        {tokens ? (
          <Row title='API tokens' description='Keys your scripts and integrations authenticate with.'>
            {tokens}
          </Row>
        ) : null}
      </div>
    </div>
  )
}
