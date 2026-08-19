'use client'

// The scoped selection, wired to the kit's badge.
//
// The badge itself is a kit component and lives in agent-chat — a composer
// chip is chat, whatever the host is. What stays here is the only part that
// could not travel: reading the surrounding selection scope
// (selection-context.tsx) and turning it into the props the badge takes.
// Rendering nothing without a provider, or without a selection, is this
// wiring's job too — the badge holds no selection, so it cannot know one was
// never set.

import { SelectionBadge as KitSelectionBadge } from 'agent-chat/components/ui/composer/selection-badge'

import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

export function SelectionBadge() {
  const scope = useOptionalSelection()
  if (!scope?.selection) {
    return null
  }
  return (
    <KitSelectionBadge
      label={scope.selection.label}
      included={scope.passEnabled}
      onToggleIncluded={scope.togglePass}
      onClear={scope.clearSelection}
    />
  )
}
