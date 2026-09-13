'use client'

// The scoped selection's switch, wired to the kit's toggle.
//
// Sibling of selection-badge.tsx and the same kind of wiring: read the
// surrounding scope, hand the kit component its props. The two are separate
// files because they stand in separate places — the quotation above the
// composer, this in the action row below it — and each is the whole of what
// belongs in its own.
//
// THE PROVIDER IS THE WHOLE CONDITION, and this is the one place the two
// wirings differ. The quotation draws when there is something to quote; this
// draws wherever the answer it sets can be kept, which is anywhere a scope is
// mounted. A surface with no provider has nowhere to put the answer, so there
// is nothing to ask.
//
// It flips `passEnabled` and touches nothing else. The selection itself is
// untouched, so a second press brings the same one straight back; whatever
// published it goes on publishing it either way.

import { SelectionToggle as KitSelectionToggle } from 'agent-chat/components/selection-toggle'

import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'

export function SelectionToggle() {
  const scope = useOptionalSelection()
  if (!scope) {
    return null
  }
  return <KitSelectionToggle label={scope.selection?.label} included={scope.passEnabled} onToggle={scope.togglePass} />
}
