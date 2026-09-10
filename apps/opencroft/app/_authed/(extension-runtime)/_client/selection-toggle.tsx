'use client'

// The scoped selection's switch, wired to the kit's toggle.
//
// Sibling of selection-badge.tsx and the same kind of wiring: read the
// surrounding scope, hand the kit component its props, render nothing when
// there is no provider or no selection. The two are separate files because
// they stand in separate places — the quotation above the composer, this in
// the action row below it — and each is the whole of what belongs in its own.
//
// It flips `passEnabled` and touches nothing else. The selection itself is
// untouched, so a second press brings the same one straight back; whatever
// published it goes on publishing it either way.

import { SelectionToggle as KitSelectionToggle } from 'agent-chat/components/ui/composer/selection-toggle'

import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

export function SelectionToggle() {
  const scope = useOptionalSelection()
  if (!scope?.selection) {
    return null
  }
  return <KitSelectionToggle label={scope.selection.label} included={scope.passEnabled} onToggle={scope.togglePass} />
}
