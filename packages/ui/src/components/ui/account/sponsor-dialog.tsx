'use client'

import { Heart } from 'lucide-react'

import { buttonVariants } from '../button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../dialog'

export interface SponsorDialogProps {
  open: boolean
  /** Called with `false` however the dialog is closed: the close button, Escape or the backdrop. */
  onOpenChange: (open: boolean) => void
  /** The Sponsors page. The button opens it in a new tab. */
  href: string
  /** Called when the button is pressed, alongside the link opening. */
  onSponsor?: () => void
}

export function SponsorDialog({ open, onOpenChange, href, onSponsor }: SponsorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thank you for using OpenCroft</DialogTitle>
          <DialogDescription>
            Sponsorship pays for the time that goes into building and maintaining it, so it stays open source and keeps
            getting better.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <a href={href} target='_blank' rel='noopener noreferrer' onClick={onSponsor} className={buttonVariants()}>
            <Heart />
            Sponsor on GitHub
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
