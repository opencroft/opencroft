'use client'

import type { MarkdownResolver } from '@opencroft/client'
import { useRouter } from '@tanstack/react-router'
import type { InlineReference } from 'agent-chat/components/markdown-references'
import { ReferenceChip } from 'agent-chat/components/reference-chip'
import { useEffect, useSyncExternalStore } from 'react'

import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { ReferenceStore, referenceIcon } from '@/app/_authed/(extension-runtime)/_client/markdown-reference-store'
import { useProvided } from '@/app/_authed/(extension-runtime)/_client/provides'
import { resolveIcon } from '@/app/_authed/(extension-runtime)/_client/registry'

// Markdown resolvers: the extensions' `provides.markdownResolvers`, and the
// chip every recognised reference is drawn as.

const POINT = 'markdownResolvers'

/** How long a reference at the end of a still-growing text waits before it is resolved. */
export const TRAILING_DELAY_MS = 400

export const referenceStore = new ReferenceStore((reference) => (
  <ResolvedReference key={`${reference.kind}\n${reference.id}`} {...reference} />
))

const isSameOrigin = (href: string) => {
  try {
    return new URL(href, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

function ResolvedReference({ kind, id, trailing }: InlineReference) {
  const router = useRouter()
  const entry = useSyncExternalStore(
    (listener) => referenceStore.subscribe(kind, id, listener),
    () => referenceStore.get(kind, id),
    () => referenceStore.get(kind, id),
  )
  // A reference ending a text that is still arriving may be the first half of
  // a longer one; it waits for the text to settle rather than being asked for
  // at every length it passes through.
  useEffect(() => {
    if (!trailing) {
      referenceStore.request(kind, id)
      return
    }
    const timer = setTimeout(() => referenceStore.request(kind, id), TRAILING_DELAY_MS)
    return () => clearTimeout(timer)
  }, [kind, id, trailing])

  const shown = referenceStore.shown(kind, id, entry)
  const menu = referenceStore.resolver(kind)?.menu?.(id, entry?.reference ?? null) ?? []
  const { href } = shown
  const open = shown.open ?? (href && isSameOrigin(href) ? () => router.history.push(href) : undefined)
  return (
    <ReferenceChip
      label={shown.label}
      detail={shown.detail}
      state={shown.state}
      icon={referenceIcon(shown.icon)}
      tone={shown.tone}
      stateLabel={shown.stateLabel}
      status={entry?.status ?? 'pending'}
      href={href}
      onOpen={open}
      menu={menu.map((item) => {
        const ItemIcon = item.icon ? resolveIcon(item.icon) : null
        return {
          label: item.label,
          icon: ItemIcon ? <ItemIcon className='size-3.5' /> : undefined,
          onSelect: item.onSelect,
        }
      })}
    />
  )
}

/**
 * Keeps the reference source in step with the extensions' resolvers. Mounted
 * once, in the signed-in shell, so every page has it; starts the shared
 * extension load if nothing else on the page has.
 */
export function MarkdownResolversHost() {
  const { items } = useProvided<MarkdownResolver>(POINT, loadAllExtensions)
  useEffect(() => {
    referenceStore.sync(items)
  }, [items])
  return null
}
