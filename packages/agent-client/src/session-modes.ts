// Our vocabulary for the permission modes agents run in.
//
// ACP session modes are free-form: an agent advertises whatever `{id, name,
// description}` triples it likes, and two agents that behave identically can
// spell the same mode differently — `acceptEdits` vs `accept_edits`, `default`
// vs `manual`. That is right for the protocol and wrong for a UI, which needs a
// stable handle to hang an icon, a colour and an ordering off.
//
// So the ids below are OURS, not any agent's, and what agents call things is
// registered as synonyms (see synonyms.ts). `reject-edits` is the clearest
// case: Claude Code calls it `dontAsk`, which describes the prompt rather than
// the outcome, and echoing that would have put its vocabulary at the centre of
// ours. Everything downstream operates on our values only.
//
// This classifies, it does not replace: what a session ADVERTISES still comes
// from the session, and an unrecognised mode passes through with the agent's
// own name rather than being hidden.
//
// Carries no icons or colours — those are presentation, and belong to whichever
// surface renders the mode.

import { createSynonymResolver } from './synonyms'
import type { SessionMode } from './types'

/**
 * Our modes, in menu order.
 *
 * - `auto` — a classifier decides each request instead of the user.
 * - `plan` — the agent may think and read but executes nothing.
 * - `manual-edits` — the agent asks before anything consequential. The usual default.
 * - `accept-edits` — file edits go through unattended; other operations still ask.
 * - `reject-edits` — nothing is asked; anything not pre-approved is DENIED.
 * - `bypass` — nothing is asked; everything is ALLOWED.
 *
 * `reject-edits` and `bypass` are both "stops asking" and are opposites in what
 * that silence means, so they must never collapse into one another.
 */
export type CanonicalModeId = 'auto' | 'plan' | 'manual-edits' | 'accept-edits' | 'reject-edits' | 'bypass'

export interface CanonicalModeInfo {
  id: CanonicalModeId
  /** Display label, replacing whatever the agent called it. */
  label: string
  /** What the mode does, in host-agnostic terms. */
  description: string
  /**
   * Position in the menu, ascending. Presentation order is a product decision
   * rather than something derivable — it is NOT a severity ramp (`auto` leads
   * while being far from the least permissive) — so it is stated once here
   * instead of re-derived, differently, by each surface.
   */
  order: number
}

export const CANONICAL_MODES: Record<CanonicalModeId, CanonicalModeInfo> = {
  auto: {
    id: 'auto',
    label: 'Auto',
    description: 'A classifier approves or denies each request instead of the user.',
    order: 0,
  },
  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Plans and reads only — executes nothing.',
    order: 1,
  },
  'manual-edits': {
    id: 'manual-edits',
    label: 'Manual Edits',
    description: 'Asks before any consequential operation.',
    order: 2,
  },
  'accept-edits': {
    id: 'accept-edits',
    label: 'Accept Edits',
    description: 'Applies file edits without asking; still asks about everything else.',
    order: 3,
  },
  'reject-edits': {
    id: 'reject-edits',
    label: 'Reject Edits',
    description: 'Never asks; denies anything not already permitted.',
    order: 4,
  },
  bypass: {
    id: 'bypass',
    label: 'Bypass Permissions',
    description: 'Never asks; permits everything. No approval gate remains.',
    order: 5,
  },
}

const MODE_IDS = Object.keys(CANONICAL_MODES) as CanonicalModeId[]

/**
 * Spellings that mean one of ours, for any agent. Matched exactly, and filled
 * by hand as agents are encountered — a spelling nobody has looked at should
 * show up as unrecognised rather than be absorbed by a rule that happened to
 * fit. `auto` and `plan` need no entry: agents already spell those as we do.
 */
const SHARED_MODE_SYNONYMS = {
  'manual-edits': ['manual'],
  'accept-edits': ['acceptEdits'],
  'reject-edits': ['dontAsk'],
  bypass: ['bypassPermissions'],
}

/**
 * Per-adapter registrations, for spellings that are ambiguous across agents and
 * can only be read safely against one.
 *
 * `default` is the whole reason this layer exists separately from the shared
 * one. Claude Code kept that wire id after renaming the mode to "Manual", so
 * for Claude it means manual-edits — but "default" says nothing about
 * behaviour in general, and another agent could reasonably use it for anything.
 * Registering it here rather than above keeps the guess scoped to the agent it
 * was verified against (bridge 0.66.0's buildAvailableModes()).
 *
 * Both Claude adapters drive the same bridge binary and differ only in billing.
 */
const CLAUDE_MODE_SYNONYMS = { 'manual-edits': ['default'] }
const ADAPTER_MODE_SYNONYMS: Record<string, typeof CLAUDE_MODE_SYNONYMS> = {
  claude: CLAUDE_MODE_SYNONYMS,
  'claude-subscription': CLAUDE_MODE_SYNONYMS,
}

const resolver = createSynonymResolver<CanonicalModeId>(MODE_IDS, SHARED_MODE_SYNONYMS, ADAPTER_MODE_SYNONYMS)

/**
 * Our id for an agent-advertised mode id, or undefined when nothing recognises
 * it. Undefined is a normal answer: an unknown mode is still a real mode the
 * session offers, and a caller should render it from the agent's own
 * `name`/`description` rather than hide it.
 */
export function canonicalModeId(adapterId: string, modeId: string): CanonicalModeId | undefined {
  return resolver.resolve(adapterId, modeId)
}

/** A session mode paired with its classification, if it has one. */
export interface ClassifiedMode extends SessionMode {
  canonical?: CanonicalModeInfo
}

/**
 * Pair each of a session's advertised modes with its classification. Order and
 * membership are the agent's — this never adds a mode the session did not
 * offer, and never drops one it did. Surfaces that want our menu order sort by
 * `CanonicalModeInfo.order` themselves.
 */
export function classifyModes(adapterId: string, modes: SessionMode[]): ClassifiedMode[] {
  return modes.map((mode) => {
    const id = canonicalModeId(adapterId, mode.id)
    return id ? { ...mode, canonical: CANONICAL_MODES[id] } : { ...mode }
  })
}

/**
 * The wire id this session would use for one of ours, or undefined when it does
 * not offer one — resolved against what the session actually advertised rather
 * than against the synonym tables.
 *
 * Resolving against the live list matters for exactly the case that motivates
 * this: several modes are conditional (Claude Code offers `bypassPermissions`
 * only when its own ALLOW_BYPASS holds), so a table lookup would happily return
 * an id the agent will reject. Undefined means "this session cannot go there",
 * which a caller has to handle rather than force.
 */
export function modeIdForCanonical(
  adapterId: string,
  modes: SessionMode[],
  canonical: CanonicalModeId,
): string | undefined {
  return modes.find((mode) => canonicalModeId(adapterId, mode.id) === canonical)?.id
}
