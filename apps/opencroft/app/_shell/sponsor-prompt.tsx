'use client'

import { updateUser, useSession } from '@opencroft/auth/client'
import { useEffect, useState } from 'react'
import { SponsorDialog } from 'ui/account/sponsor-dialog'

import { isSponsorPromptDue, SPONSOR_URL } from '@/app/_shell/sponsor'

// What already holds the person's attention: any open dialog (the kit's
// dialogs, sheets and popovers all render one of these roles while open), and
// the cards that ask them to answer or approve something for an agent.
//
// The contract this relies on: a surface matching this selector is in the
// document only while it holds attention, and is removed when it closes. One
// kept mounted and merely hidden would hold the prompt back for the whole page
// load, and the watcher below only notices elements being added and removed.
const ATTENTION_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[data-slot="approvals"]',
  '[data-slot="ask-user-request"]',
].join(', ')

/**
 * Whether nothing else on the page holds the person's attention. The page is
 * watched only while `watching`, so a prompt that is not due costs nothing.
 */
function usePageIsFree(watching: boolean): boolean {
  const [free, setFree] = useState(false)

  useEffect(() => {
    if (!watching) {
      return
    }
    const check = () => setFree(document.querySelector(ATTENTION_SELECTOR) === null)
    check()
    const observer = new MutationObserver(check)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [watching])

  return watching && free
}

/**
 * When a prompt that is `due` is on screen. It waits until nothing else holds
 * the person's attention, then stays up, even if another dialog opens over it,
 * until `close` is called or it stops being due. Once closed it stays closed
 * for the life of the page.
 */
export function usePromptVisibility(due: boolean): { open: boolean; close: () => void } {
  const [phase, setPhase] = useState<'waiting' | 'open' | 'closed'>('waiting')
  const free = usePageIsFree(due && phase === 'waiting')

  useEffect(() => {
    if (free) {
      setPhase('open')
    }
  }, [free])

  return { open: due && phase === 'open', close: () => setPhase('closed') }
}

/**
 * Thanks the signed-in person once a calendar month, with a way to sponsor
 * the project. Any close, and pressing the Sponsor button, records it as seen
 * on the account, so it does not return this month in any browser; other open
 * tabs pick the change up from their session and close theirs.
 */
export function SponsorPrompt() {
  const { data: session } = useSession()
  const due = session != null && isSponsorPromptDue(session.user.sponsorPromptSeenAt, new Date())
  const { open, close } = usePromptVisibility(due)

  const markSeen = () => {
    close()
    // A failed save only means the prompt comes back on the next page load,
    // which is the right fallback for a thank-you, so it is not reported.
    updateUser({ sponsorPromptSeenAt: new Date() }).catch(() => undefined)
  }

  return (
    <SponsorDialog open={open} onOpenChange={(next) => !next && markSeen()} href={SPONSOR_URL} onSponsor={markSeen} />
  )
}
