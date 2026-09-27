import {
  describeGraphRefs,
  legacy,
  type MarkdownReference,
  type MarkdownReferenceMenuItem,
  type MarkdownResolver,
  subscribeGraphRefs,
} from '@opencroft/client'

import { sameOriginLinkPattern, TERMINAL_TARGET_PATTERN } from './markdown-patterns'

// Graph references in text, drawn as what they point at.

function copyItem(label: string, text: string): MarkdownReferenceMenuItem {
  return {
    label,
    icon: 'Copy',
    onSelect: () => {
      navigator.clipboard.writeText(text).then(
        () => legacy.toast.success('Copied', { duration: 1500 }),
        () => legacy.toast.error('Could not copy to the clipboard'),
      )
    },
  }
}

const spaceHref = (spaceSlug: string) => `/space/${encodeURIComponent(spaceSlug)}`

export const terminalResolver: MarkdownResolver = {
  id: 'core.terminal',
  pattern: TERMINAL_TARGET_PATTERN,
  preview: () => ({ icon: 'SquareTerminal' }),
  resolve: async (targets) => {
    const described = await describeGraphRefs(targets)
    return Object.fromEntries(
      targets.map((target): [string, MarkdownReference | null] => {
        const ref = described[target]
        return [
          target,
          ref
            ? {
                label: ref.name,
                detail: ref.detail ? `· ${ref.detail}` : undefined,
                icon: ref.icon ?? 'SquareTerminal',
                href: spaceHref(ref.spaceSlug),
              }
            : null,
        ]
      }),
    )
  },
  subscribe: (invalidate) => subscribeGraphRefs(() => invalidate()),
  menu: (target) => [copyItem('Copy target', target)],
}

const APP_PATH = /^\/space\/([^/]+)\/app\/([^/]+)(?:\/(.*))?$/
const SPACE_PATH = /^\/space\/([^/]+)\/?$/

/** A bare link into this instance, drawn as the App or space it opens. External links are left alone. */
export const linkResolver: MarkdownResolver = {
  id: 'core.link',
  match: 'url',
  pattern: typeof window === 'undefined' ? null : sameOriginLinkPattern(window.location.origin),
  preview: () => ({ icon: 'Link' }),
  resolve: async (urls) => {
    const parsed = urls.map((url) => {
      const { pathname, search, hash } = new URL(url)
      const app = APP_PATH.exec(pathname)
      return { url, pathname, rest: `${pathname}${search}${hash}`, app }
    })
    const addresses = parsed.flatMap(({ app }) => (app ? [`${decodeURIComponent(app[1])}.${app[2]}`] : []))
    const described = addresses.length ? await describeGraphRefs(addresses) : {}
    return Object.fromEntries(
      parsed.map(({ url, pathname, rest, app }): [string, MarkdownReference | null] => {
        if (app) {
          const ref = described[`${decodeURIComponent(app[1])}.${app[2]}`]
          if (!ref) {
            return [url, null]
          }
          const page = app[3] ? decodeURIComponent(app[3]) : ''
          const detail = page ? `· ${page}` : undefined
          return [url, { label: ref.name, detail, icon: ref.icon ?? 'AppWindow', href: url }]
        }
        const space = SPACE_PATH.exec(pathname)
        if (space) {
          return [url, { label: decodeURIComponent(space[1]), icon: 'LayoutGrid', href: url }]
        }
        // The first path segment names it; the rest may be long, so it is the
        // part that truncates.
        const cut = rest.slice(1).search(/[/?#]/) + 1
        return [
          url,
          cut > 0
            ? { label: rest.slice(0, cut), detail: rest.slice(cut), icon: 'Link', href: url }
            : { label: rest, icon: 'Link', href: url },
        ]
      }),
    )
  },
  subscribe: (invalidate) => subscribeGraphRefs(() => invalidate()),
  menu: (url) => [copyItem('Copy link', url)],
}
