'use client'

import { cn } from 'cn'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { PaletteHue } from 'ui/components/ui/input/color-palette'

import { CollaboratorTag, tetherTagElement, useTagAnchorName } from './collaborator-caret'

/*
 * An agent's change to a text, as the people reading it see it arrive. An
 * agent does not type, so it is not drawn as a caret racing through letters:
 * the agent's colour sweeps across the text it replaces like a highlighter,
 * the new text takes that text's place inside the highlight and fades in, and
 * the colour fades. The agent's name stays above the change throughout.
 *
 * The new text is already in the document; all of this is presentation. It
 * is CSS animation throughout, so an editor sets a change up once, with no
 * work per frame: until `oldGone` it shows the replaced content as the
 * document drew it -- formatting, blocks and all -- and hides the new text
 * outright (`AGENT_EDIT_HIDDEN_STYLE`), so the line keeps its layout while
 * the old content is swept; then it takes the replaced content out and shows
 * the new text with `agentEditNewStyle`; at `end` it is over.
 *
 * Text fades by its colour, not its opacity: under partial opacity a tint of
 * a wide-gamut palette colour can render as its opposite hue in Chromium
 * (seen as yellow behind violet).
 */

export interface AgentEditPlan {
  reducedMotion: boolean
  /**
   * When the replaced text has been swept: until then the new text takes no
   * space at all; then the replaced text goes and the new text comes in. 0
   * for an insertion, and with reduced motion.
   */
  oldGone: number
  /** When the playback, its fading included, is over. */
  end: number
}

/** How long the highlighter takes to cross the replaced text. */
const SWEEP_MS = 500
/** How long the swept text takes to fade before the new text takes its place. */
const SWEPT_FADE_MS = 200
/** How long the new text takes to fade in and its highlight to fade out. */
const ARRIVE_MS = 1_700
const HIGHLIGHT_MS = 900

/** When each part of a change happens: one that `replaces` content, or an insertion. The same however long the change. */
export function agentEditPlan(
  { replaces }: { replaces: boolean },
  { reducedMotion = false }: { reducedMotion?: boolean } = {},
): AgentEditPlan {
  if (reducedMotion) {
    return { reducedMotion, oldGone: 0, end: HIGHLIGHT_MS }
  }
  const oldGone = replaces ? SWEEP_MS + SWEPT_FADE_MS : 0
  return { reducedMotion, oldGone, end: oldGone + ARRIVE_MS }
}

const KEYFRAMES = `
@keyframes agent-edit-arrive {
  0% { color: transparent; background-color: var(--agent-edit-tint) }
  35% { color: currentcolor; background-color: var(--agent-edit-tint) }
  100% { color: currentcolor; background-color: transparent }
}
@keyframes agent-edit-highlight {
  from { background-color: var(--agent-edit-tint) }
  to { background-color: transparent }
}
@keyframes agent-edit-sweep {
  from { background-position: 100% 0 }
  to { background-position: 0 0 }
}
@keyframes agent-edit-out {
  to { color: transparent; -webkit-text-fill-color: transparent; background-color: transparent }
}
@keyframes agent-edit-label {
  from { transform: translateY(3px) }
  to { transform: none }
}
`

/** Adds the animations' keyframes to the page, once. Call before drawing a change. */
export function ensureAgentEditStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('agent-edit-keyframes')) {
    return
  }
  const style = document.createElement('style')
  style.id = 'agent-edit-keyframes'
  style.textContent = KEYFRAMES
  document.head.append(style)
}

function colours(hue: PaletteHue): string {
  const colour = `var(--color-${hue}-500)`
  return [
    `--agent-edit-tint: color-mix(in oklab, ${colour} 22%, transparent)`,
    `--agent-edit-strong: color-mix(in oklab, ${colour} 40%, transparent)`,
  ].join('; ')
}

/** The style of the new text -- its text and any whole block of it -- until `oldGone`: it takes no space. */
export const AGENT_EDIT_HIDDEN_STYLE = 'display: none'

/** The inline style of the new text from `oldGone`, when it comes in. */
export function agentEditNewStyle(plan: AgentEditPlan, hue: PaletteHue): string {
  const animation = plan.reducedMotion
    ? `agent-edit-highlight ${HIGHLIGHT_MS}ms ease-out both`
    : `agent-edit-arrive ${ARRIVE_MS}ms ease-out both`
  return `${colours(hue)}; animation: ${animation}; border-radius: 2px`
}

/** The style of the replaced content while it is swept: of the run of inline content, or of each block. */
export function agentEditOldStyle(hue: PaletteHue): string {
  return [
    colours(hue),
    'background-image: linear-gradient(90deg, var(--agent-edit-strong) 50%, transparent 50%)',
    'background-size: 200% 100%',
    `animation: agent-edit-sweep ${SWEEP_MS}ms ease-in-out both, agent-edit-out ${SWEPT_FADE_MS}ms ease-in ${SWEEP_MS}ms both`,
    'border-radius: 2px',
  ].join('; ')
}

/**
 * The replaced content as an element, for an editor that places elements at
 * positions: copies of `content`, the nodes that drew it in the document, so
 * it is swept looking as it did. Inline content is swept as one run in the
 * line; `blocks` stand where they stood, between the blocks around them, and
 * each is swept.
 */
export function agentEditOldElement(
  content: readonly Node[],
  hue: PaletteHue,
  { blocks = false }: { blocks?: boolean } = {},
): HTMLElement {
  const old = document.createElement(blocks ? 'div' : 'span')
  old.append(...content.map((node) => node.cloneNode(true)))
  if (!blocks) {
    old.setAttribute('style', agentEditOldStyle(hue))
    return old
  }
  // The wrapper makes no box of its own, so each block lays out as it did.
  old.setAttribute('style', 'display: contents')
  for (const block of old.children) {
    block.setAttribute('style', [block.getAttribute('style'), agentEditOldStyle(hue)].filter(Boolean).join('; '))
  }
  return old
}

// The agent's name, steady above where the change is: no caret, no blinking.
// In a line the anchor is a line tall and sits at the top of the text, so the
// label is above the line rather than over the first word; between blocks it
// takes no height, so the blocks do not move. The label is a collaborator's
// name tag, tethered to its anchor the same way and for the same reason: so
// that a box the text scrolls in -- a table's frame, the editor -- neither
// cuts it off nor scrolls further for it.
const LABEL_ANCHOR = 'pointer-events-none relative inline-block h-[1lh] w-0 align-top'
const LABEL_BLOCK_ANCHOR = 'pointer-events-none relative block h-0'
const LABEL_ANIMATION = 'agent-edit-label 200ms ease-out both'

function labelColour(hue: PaletteHue): string {
  return `text-${hue}-500`
}

/** The agent's name label as an element, placed at the start of the change: in a line, or before `blocks`. */
export function agentEditLabelElement(
  name: string,
  hue: PaletteHue,
  { blocks = false }: { blocks?: boolean } = {},
): HTMLElement {
  const anchor = document.createElement(blocks ? 'div' : 'span')
  anchor.className = cn(blocks ? LABEL_BLOCK_ANCHOR : LABEL_ANCHOR, labelColour(hue))
  tetherTagElement(anchor, name).style.animation = LABEL_ANIMATION
  return anchor
}

function styleObject(style: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const declaration of style.split(/;(?![^(]*\))/)) {
    const at = declaration.indexOf(':')
    if (at < 0) {
      continue
    }
    const property = declaration.slice(0, at).trim()
    const key = property.startsWith('--') ? property : property.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
    result[key] = declaration.slice(at + 1).trim()
  }
  return result
}

export interface AgentEditProps {
  /** The agent's name, shown above the change. */
  name: string
  /** The agent's colour. */
  hue: PaletteHue
  /** The text before and after the change, which stays as it is. */
  before?: ReactNode
  after?: ReactNode
  /** What the agent replaced, formatted as the text shows it; absent for an insertion. */
  replaced?: ReactNode
  /** What the agent wrote. */
  inserted: ReactNode
  /** Draw it as for a reader who asked for reduced motion. Defaults to that reader's setting. */
  reducedMotion?: boolean
  /** Play it again after a pause, for as long as it is shown. */
  loop?: boolean
  className?: string
}

/** A line of text with an agent's change arriving in it. */
export function AgentEdit({
  name,
  hue,
  before,
  after,
  replaced,
  inserted,
  reducedMotion,
  loop = false,
  className,
}: AgentEditProps) {
  const [prefersReduced, setPrefersReduced] = useState(false)
  useEffect(() => {
    ensureAgentEditStyles()
    setPrefersReduced(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [])
  const replaces = Boolean(replaced)
  const plan = useMemo(
    () => agentEditPlan({ replaces }, { reducedMotion: reducedMotion ?? prefersReduced }),
    [replaces, reducedMotion, prefersReduced],
  )
  const [round, setRound] = useState(0)
  const [oldShown, setOldShown] = useState(true)
  const [playing, setPlaying] = useState(true)
  useEffect(() => {
    setOldShown(true)
    setPlaying(true)
    const timers = [
      setTimeout(() => setOldShown(false), plan.oldGone),
      setTimeout(() => setPlaying(false), plan.end),
    ]
    if (loop) {
      timers.push(setTimeout(() => setRound((n) => n + 1), plan.end + 1_500))
    }
    return () => timers.forEach(clearTimeout)
  }, [plan, loop, round])

  const anchor = useTagAnchorName()

  const swept = replaces && oldShown && plan.oldGone > 0
  return (
    <p className={cn('pt-6', className)} key={round}>
      {before}
      {playing && (
        <span className={cn(LABEL_ANCHOR, labelColour(hue))} style={{ anchorName: anchor }}>
          <CollaboratorTag name={name} anchor={anchor} style={{ animation: LABEL_ANIMATION }} />
        </span>
      )}
      {swept ? (
        <span style={styleObject(agentEditOldStyle(hue))}>{replaced}</span>
      ) : (
        <span style={playing ? styleObject(agentEditNewStyle(plan, hue)) : undefined}>{inserted}</span>
      )}
      {after}
    </p>
  )
}
