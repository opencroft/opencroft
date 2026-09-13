'use client'

// The scoped selection, quoted above the composer through the kit's badge.
//
// The badge itself is a kit component and lives in agent-chat — a composer
// quotation is chat, whatever the host is. What stays here is the only part
// that could not travel: reading the surrounding selection scope
// (selection-context.tsx) and turning it into the props the badge takes.
// Rendering nothing without a provider, or without a selection, is this
// wiring's job too — the badge holds no selection, so it cannot know one was
// never set.
//
// AND NOTHING WHILE THE SELECTION IS HELD BACK. The toggle beside the context
// ring (selection-toggle.tsx) governs one flag with two consequences, and this
// is the first of them: held back means not quoted here, not only not sent.
// The second is at the send transport, which reads the same flag.

import { SelectionBadge as KitSelectionBadge } from 'agent-chat/components/selection-badge'

import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

export function SelectionBadge() {
  const scope = useOptionalSelection()
  if (!scope?.selection || !scope.passEnabled) {
    return null
  }
  // The label and nothing else. What the agent receives is not shown here and
  // is not handed over either — not even as a tooltip: the composer says what
  // is going, and what that is made of stays where it was published.
  return <KitSelectionBadge label={scope.selection.label} />
}
