// Measures markdown references on a long chat thread, before and after:
// render time, and how many resolve requests the identifiers on screen cost.
//
//   cd apps/opencroft && TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx scripts/bench-markdown-references.tsx
//
// "Before" renders the thread with no reference source installed, which is
// exactly what the app did before resolvers existed. "After" installs the
// real store with three resolvers shaped like the shipped ones (task keys,
// terminal targets, same-origin links), each answering after a delay the way a
// server round trip would, and chips that request the way the host's do.

import { JSDOM } from 'jsdom'

const ORIGIN = 'https://opencroft.example.test'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}/`, pretendToBeVisual: true })
const globals = globalThis as unknown as Record<string, unknown>
globals.window = dom.window
for (const name of ['document', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'getComputedStyle', 'Event']) {
  globals[name] = (dom.window as unknown as Record<string, unknown>)[name]
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })

const MESSAGES = 300
const RESOLVE_LATENCY_MS = 30
// The host chip's delay for a reference ending a text still arriving.
const TRAILING_DELAY_MS = 400

function thread(): string[] {
  const key = (n: number) => `DEMO-${(n % 120) + 1}`
  return Array.from({ length: MESSAGES }, (_, i) =>
    [
      `Message ${i}: picked up ${key(i)} and ${key(i * 7)}, see also WEB-${(i % 40) + 1}.`,
      `Ran it on localhost_ab${i % 25}/terminal and myspace.git/worktree-terminal-repo-task${i % 10}.`,
      `Details: ${ORIGIN}/space/demo/app/tasks/task/${key(i * 3)}`,
      '',
      '```',
      `${key(i)} inside a fence stays code`,
      '```',
      '',
      `Not ids: UTF-8, SHA-256, lib/terminal-utils, \`${key(i)}\`.`,
    ].join('\n'),
  )
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function main() {
  const React = await import('react')
  const { flushSync } = await import('react-dom')
  const { createRoot } = await import('react-dom/client')
  const { Markdown } = await import('agent-chat/components/markdown')
  const { findReferences, getMarkdownReferences, installMarkdownReferences } = await import(
    'agent-chat/components/markdown-references'
  )
  const { ReferenceChip } = await import('agent-chat/components/reference-chip')
  const { ReferenceStore } = await import('../app/_authed/(extension-runtime)/_client/markdown-reference-store')
  const { TERMINAL_TARGET_PATTERN, sameOriginLinkPattern } = await import(
    '../app/_authed/(extension-runtime)/_builtin/core/src/markdown-patterns'
  )
  type InlineReference = import('agent-chat/components/markdown-references').InlineReference
  type MarkdownResolver = import('@opencroft/client').MarkdownResolver

  const messages = thread()

  function renderThread(texts: string[]) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const start = performance.now()
    flushSync(() => {
      // Every message opens with its own number, so its first line is a key.
      root.render(texts.map((text) => <Markdown key={text.slice(0, text.indexOf(':'))} text={text} />))
    })
    return { ms: performance.now() - start, root, container }
  }

  // ── Before: no source installed ───────────────────────────────────────────
  installMarkdownReferences(null)
  renderThread(messages.slice(0, 20)).root.unmount() // warm modules and the JIT
  const beforeRuns = [0, 1, 2].map(() => {
    const run = renderThread(messages)
    run.root.unmount()
    return run.ms
  })

  // ── After: the store, three resolvers, chips requesting as the host's do ──
  const calls: Record<string, number> = {}
  const resolver = (id: string, match: 'text' | 'url', pattern: RegExp | string): MarkdownResolver => ({
    id,
    match,
    pattern,
    resolve: async (ids) => {
      calls[id] = (calls[id] ?? 0) + 1
      await wait(RESOLVE_LATENCY_MS)
      return Object.fromEntries(ids.map((ref) => [ref, { label: `${ref} resolved`, tone: 'info' as const }]))
    },
    subscribe: () => () => {},
  })
  function Chip({ kind, id, trailing }: InlineReference) {
    const entry = React.useSyncExternalStore(
      (listener) => store.subscribe(kind, id, listener),
      () => store.get(kind, id),
    )
    React.useEffect(() => {
      if (!trailing) {
        store.request(kind, id)
        return
      }
      const timer = setTimeout(() => store.request(kind, id), TRAILING_DELAY_MS)
      return () => clearTimeout(timer)
    }, [kind, id, trailing])
    const shown = store.shown(kind, id, entry)
    return <ReferenceChip label={shown.label} tone={shown.tone} status={entry?.status ?? 'pending'} />
  }
  const store = new ReferenceStore((reference) => <Chip key={`${reference.kind}\n${reference.id}`} {...reference} />)
  store.sync([
    resolver('tasks.key', 'text', '\\b(?:DEMO|WEB)-[1-9]\\d*\\b'),
    resolver('core.terminal', 'text', TERMINAL_TARGET_PATTERN),
    resolver('core.link', 'url', sameOriginLinkPattern(ORIGIN)),
  ])

  // What there is to claim: text matches found the way the plugin finds them,
  // plus the one bare same-origin link each message carries.
  const recognisers = getMarkdownReferences()?.recognisers ?? []
  const distinct = new Set<string>()
  let chips = 0
  for (const text of messages) {
    const link = /https:\S+/.exec(text)?.[0] as string
    chips += 1
    distinct.add(`link ${link}`)
    const prose = text
      .replace(link, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
    for (const match of findReferences(prose, recognisers)) {
      chips += 1
      distinct.add(`${match.kind} ${match.id}`)
    }
  }
  const distinctIds = distinct.size

  const after = renderThread(messages)
  const hydrateStart = performance.now()
  const resolvedCount = () => after.container.textContent?.match(/ resolved/g)?.length ?? 0
  while (resolvedCount() < chips && performance.now() - hydrateStart < 5000) {
    await wait(2)
  }
  const hydratedMs = performance.now() - hydrateStart
  const chipsHydrated = resolvedCount()
  const afterStats = { ...store.stats }
  const afterCalls = { ...calls }
  after.root.unmount()

  // ── The same thread again: everything is cached ───────────────────────────
  const rerender = renderThread(messages)
  await wait(RESOLVE_LATENCY_MS * 3)
  rerender.root.unmount()
  const rerenderCalls = store.stats.resolveCalls - afterStats.resolveCalls

  // ── Streaming: one message arriving in 5-character chunks, 30 ms apart ────
  const streamed = 'Working on it. The fix is in DEMO-4711, the follow-up is DEMO-4712, run on localhost_zz9/terminal'
  const beforeStream = { ...store.stats }
  const container = document.createElement('div')
  const root = createRoot(container)
  let chunks = 0
  for (let at = 5; at < streamed.length + 5; at += 5) {
    chunks += 1
    flushSync(() => root.render(<Markdown text={streamed.slice(0, at)} />))
    await wait(30)
  }
  await wait(TRAILING_DELAY_MS + RESOLVE_LATENCY_MS * 3)
  root.unmount()

  console.log(
    JSON.stringify(
      {
        thread: { messages: MESSAGES, chips, distinctIds },
        before: { renderMsMedianOf3: Math.round(median(beforeRuns)), resolveRequests: 0 },
        after: {
          firstPaintMs: Math.round(after.ms),
          allChipsHydratedWithinMs: Math.round(hydratedMs),
          chipsHydrated,
          resolveRequests: afterStats.resolveCalls,
          perResolver: afterCalls,
          idsRequested: afterStats.idsRequested,
          naiveOneRequestPerChip: chips,
        },
        rerenderSameThread: { resolveRequests: rerenderCalls },
        streaming: {
          chunks,
          resolveRequests: store.stats.resolveCalls - beforeStream.resolveCalls,
          idsRequested: store.stats.idsRequested - beforeStream.idsRequested,
        },
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
