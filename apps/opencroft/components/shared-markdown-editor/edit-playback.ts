import type { HocuspocusProvider } from '@hocuspocus/provider'
import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { type Mappable, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import {
  AGENT_EDIT_HIDDEN_STYLE,
  type AgentEditPlan,
  agentEditLabelElement,
  agentEditNewStyle,
  agentEditOldElement,
  agentEditPlan,
  ensureAgentEditStyles,
} from 'ui/components/ui/editing/agent-edit'
import { hueFor } from 'ui/components/ui/editing/collaborator-caret'
import type { PaletteHue } from 'ui/components/ui/input/color-palette'

import { absolutePosition } from '@/components/shared-markdown-editor/relative-position'
import {
  changeMapping,
  type ReplacedContent,
  replacedContent,
} from '@/components/shared-markdown-editor/replaced-content'
import { changedRange } from '@/lib/markdown-doc-change'
import type { MarkdownEditMessage, MarkdownEditOrigin } from '@/lib/markdown-doc-protocol'

/*
 * A change made to the shared document from outside an editor -- an agent's
 * -- shown arriving, in the kit's Agent Edit language, on the document as
 * this editor draws it: the agent's colour sweeps across the replaced
 * content, looking as it did (`./replaced-content`), the new content takes
 * its place inside the highlight and fades in, under the agent's name, and
 * the colour fades. It is not replayed as typing: an agent does not type.
 *
 * Only what is drawn is played. The document holds the change in full from
 * the start, so undo, sync and the stored markdown never see it half made.
 * The kit's sweep runs as CSS animation, so a playback is set up once -- the
 * decorations stay the same from one redraw to the next, and their animations
 * run undisturbed -- and two timers swap the swept content for the new
 * content and end it. While the replaced content is swept the new content is
 * hidden outright, blocks included, so the page keeps its layout. Typing into
 * the range being played ends its playback at once; a reader who asks for
 * reduced motion sees a brief highlight instead.
 *
 * The server announces a change right behind the change itself, and the two
 * may arrive in either order: an announcement whose positions are not in this
 * copy of the document yet waits for the change to arrive. Every change from
 * elsewhere has its replaced content kept for as long as an announcement may
 * take to follow it, since nothing else says which one an agent made.
 */

/** How long an announcement waits for its change, and a change's replaced content for its announcement. */
const PENDING_MAX_MS = 5_000

interface Playback {
  id: number
  origin: MarkdownEditOrigin
  hue: PaletteHue
  plan: AgentEditPlan
  /** The new content's range in the document, kept in step with every change. */
  from: number
  to: number
  /** Copies of the nodes that drew the replaced content. */
  old: Node[]
  /** Whether the change covers whole blocks rather than content in a line. */
  blocks: boolean
  /** Whether the replaced content is still being swept; until then the new content takes no space. */
  oldShown: boolean
}

/** The replaced content of a recent change from elsewhere, until an announcement claims it or it expires. */
interface Recent extends ReplacedContent {
  at: number
}

interface PlaybackState {
  playbacks: Playback[]
  recent: Recent[]
}

type PlaybackMeta = { add: Playback } | { oldGone: number } | { end: number }

const playbackKey = new PluginKey<PlaybackState>('markdownEditPlayback')

/** `[from, to]` moved through `mapping`, or null when it was deleted outright. */
function mapRange(from: number, to: number, mapping: Mappable): { from: number; to: number } | null {
  const start = mapping.mapResult(from, 1)
  const end = mapping.mapResult(to, -1)
  if (start.deletedAcross && end.deletedAcross) {
    return null
  }
  return { from: start.pos, to: Math.max(start.pos, end.pos) }
}

function mapPlayback(playback: Playback, mapping: Mappable): Playback | null {
  const range = mapRange(playback.from, playback.to, mapping)
  return range && { ...playback, ...range }
}

function mapRecent(recent: Recent, mapping: Mappable): Recent | null {
  const range = mapRange(recent.from, recent.to, mapping)
  const announced = mapRange(recent.announced.from, recent.announced.to, mapping)
  return range && announced && { ...recent, ...range, announced }
}

/** Whether `tr` is this editor's own change touching the range being played. */
function editsInside(tr: Transaction, playback: Playback): boolean {
  if (!tr.docChanged || isChangeOrigin(tr)) {
    return false
  }
  let touched = false
  for (const map of tr.mapping.maps) {
    map.forEach((oldStart, oldEnd) => {
      if (oldStart <= playback.to && oldEnd >= playback.from) {
        touched = true
      }
    })
  }
  return touched
}

function applyMeta(playbacks: Playback[], meta: PlaybackMeta | undefined): Playback[] {
  if (!meta) {
    return playbacks
  }
  if ('add' in meta) {
    return [...playbacks, meta.add]
  }
  if ('oldGone' in meta) {
    return playbacks.map((playback) => (playback.id === meta.oldGone ? { ...playback, oldShown: false } : playback))
  }
  return playbacks.filter((playback) => playback.id !== meta.end)
}

/**
 * Hides the new content in `[from, to)` outright, so it takes no space: its
 * inline content, and every block in the range -- one that starts inside it
 * and ends within it -- which an inline decoration would leave as an empty
 * line.
 */
function hidden(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  const decorations = [Decoration.inline(from, to, { style: AGENT_EDIT_HIDDEN_STYLE })]
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isBlock && pos >= from && pos + node.nodeSize - 1 <= to) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { style: AGENT_EDIT_HIDDEN_STYLE }))
      return false
    }
    return !node.isTextblock
  })
  return decorations
}

function decorationsOf(state: EditorState, playbacks: Playback[]): DecorationSet {
  const decorations: Decoration[] = []
  for (const playback of playbacks) {
    const { blocks } = playback
    decorations.push(
      // Ahead of the swept content at the same position.
      Decoration.widget(playback.from, () => agentEditLabelElement(playback.origin.name, playback.hue, { blocks }), {
        side: -2,
        key: `agent-edit-label-${playback.id}`,
      }),
    )
    if (playback.oldShown) {
      // The replaced content is swept where the new content will be, which takes no space meanwhile.
      decorations.push(
        Decoration.widget(playback.from, () => agentEditOldElement(playback.old, playback.hue, { blocks }), {
          side: -1,
          key: `agent-edit-old-${playback.id}`,
        }),
        ...hidden(state.doc, playback.from, playback.to),
      )
    } else if (playback.to > playback.from) {
      decorations.push(
        Decoration.inline(playback.from, playback.to, { style: agentEditNewStyle(playback.plan, playback.hue) }),
      )
    }
  }
  return DecorationSet.create(state.doc, decorations)
}

export interface EditPlaybackOptions {
  provider: HocuspocusProvider | null
  /** Who is being played back right now, whenever that changes: for presence. */
  onPlaying: (origins: MarkdownEditOrigin[]) => void
}

export const EditPlayback = Extension.create<EditPlaybackOptions>({
  name: 'markdownEditPlayback',

  addOptions() {
    return { provider: null, onPlaying: () => {} }
  },

  addProseMirrorPlugins() {
    const { provider, onPlaying } = this.options
    let nextId = 0
    // The view the replaced content is copied from, once there is one.
    let drawn: EditorView | null = null

    /**
     * When `tr` is a change from elsewhere: how it moves positions, and what
     * it replaced, copied while this editor still draws the document before it.
     */
    const changeFromElsewhere = (tr: Transaction): { mapping: Mappable; recent: Recent | null } | null => {
      const range = isChangeOrigin(tr) && tr.docChanged ? changedRange(tr.before, tr.doc) : null
      if (!range) {
        return null
      }
      const copied = drawn?.state.doc === tr.before ? replacedContent(drawn, tr.before, tr.doc, range) : null
      return { mapping: changeMapping(range), recent: copied && { ...copied, at: performance.now() } }
    }

    return [
      new Plugin<PlaybackState>({
        key: playbackKey,
        state: {
          init: () => ({ playbacks: [], recent: [] }),
          apply: (tr, { playbacks, recent }) => {
            const change = changeFromElsewhere(tr)
            // A change from elsewhere replaces the whole document in one step; it moves positions by what it
            // changed, which may be nothing at all.
            const mapping = isChangeOrigin(tr) ? (change?.mapping ?? StepMap.empty) : tr.mapping
            const now = performance.now()
            return {
              playbacks: applyMeta(
                playbacks
                  .filter((playback) => !editsInside(tr, playback))
                  .map((playback) => (tr.docChanged ? mapPlayback(playback, mapping) : playback))
                  .filter((playback): playback is Playback => playback !== null),
                tr.getMeta(playbackKey) as PlaybackMeta | undefined,
              ),
              recent: [
                ...recent
                  .filter((entry) => now - entry.at < PENDING_MAX_MS)
                  .map((entry) => (tr.docChanged ? mapRecent(entry, mapping) : entry))
                  .filter((entry): entry is Recent => entry !== null),
                ...(change?.recent ? [change.recent] : []),
              ],
            }
          },
        },
        props: {
          decorations: (state) => decorationsOf(state, playbackKey.getState(state)?.playbacks ?? []),
        },
        view: (view: EditorView) => {
          drawn = view
          const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
          const timers = new Set<ReturnType<typeof setTimeout>>()
          let playing = ''
          ensureAgentEditStyles()

          const later = (ms: number, meta: PlaybackMeta) => {
            const timer = setTimeout(() => {
              timers.delete(timer)
              view.dispatch(view.state.tr.setMeta(playbackKey, meta))
            }, ms)
            timers.add(timer)
          }

          const report = () => {
            const origins = (playbackKey.getState(view.state)?.playbacks ?? []).map((playback) => playback.origin)
            const now = JSON.stringify(origins)
            if (now !== playing) {
              playing = now
              onPlaying(origins)
            }
          }

          /** Starts playing `message`; false while its positions are not in this copy yet. */
          const start = (message: MarkdownEditMessage): boolean => {
            const from = absolutePosition(view.state, message.from)
            const to = absolutePosition(view.state, message.to)
            if (from === null || to === null || to < from) {
              return false
            }
            // A change with no replaced content kept for exactly its range comes
            // in as an insertion: one this copy did not see replace anything,
            // having arrived before this editor drew the document, and one that
            // arrived in the same update as someone else's, so that what this
            // copy saw change is wider than what the agent changed.
            const replaced = playbackKey
              .getState(view.state)
              ?.recent.find((recent) => recent.announced.from === from && recent.announced.to === to)
            const plan = agentEditPlan({ replaces: (replaced?.nodes.length ?? 0) > 0 }, { reducedMotion })
            const id = ++nextId
            const playback: Playback = {
              id,
              origin: message.origin,
              hue: hueFor(`${message.origin.kind}:${message.origin.name}`),
              plan,
              from: replaced?.from ?? from,
              to: replaced?.to ?? to,
              old: replaced?.nodes ?? [],
              blocks: replaced?.blocks ?? false,
              oldShown: plan.oldGone > 0,
            }
            view.dispatch(view.state.tr.setMeta(playbackKey, { add: playback }))
            if (plan.oldGone > 0) {
              later(plan.oldGone, { oldGone: id })
            }
            later(plan.end, { end: id })
            return true
          }

          // Announcements that arrived ahead of their change.
          let pending: { message: MarkdownEditMessage; receivedAt: number }[] = []
          let retrying = false
          const retry = () => {
            if (retrying || pending.length === 0) {
              return
            }
            retrying = true
            // Not from inside the view's update, which this is called from.
            queueMicrotask(() => {
              retrying = false
              const now = performance.now()
              pending = pending.filter(
                ({ message, receivedAt }) => !start(message) && now - receivedAt < PENDING_MAX_MS,
              )
            })
          }

          const onStateless = ({ payload }: { payload: string }) => {
            let message: MarkdownEditMessage
            try {
              message = JSON.parse(payload) as MarkdownEditMessage
            } catch {
              return
            }
            if (message.type !== 'markdown-edit') {
              return
            }
            if (!start(message)) {
              pending.push({ message, receivedAt: performance.now() })
            }
          }
          provider?.on('stateless', onStateless)

          return {
            update: () => {
              report()
              retry()
            },
            destroy: () => {
              provider?.off('stateless', onStateless)
              drawn = null
              pending = []
              for (const timer of timers) {
                clearTimeout(timer)
              }
            },
          }
        },
      }),
    ]
  },
})
