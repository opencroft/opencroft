// A fixed vocabulary for the permission modes agents run in.
//
// ACP session modes are free-form: an agent advertises whatever `{id, name,
// description}` triples it likes (see SessionMode), and two agents that behave
// identically can spell the same mode differently — `acceptEdits` vs
// `accept_edits`, `default` vs `manual`. That is right for the protocol and
// wrong for a UI, which needs a stable handle to hang an icon, a colour and an
// ordering off. Everything a session ADVERTISES still comes from the session
// (see ConfigOptionsBar, which builds its selectors from the live list and
// never a hardcoded one); this module only adds a recognised-mode label on top,
// and says nothing at all about modes it does not recognise.
//
// Deliberately carries no icons or colours: those are presentation, and belong
// to whichever surface renders the mode. What lives here is the classification
// and the semantics behind it.

import type { SessionMode } from './types'

/**
 * The canonical modes, listed in the menu order defined below.
 *
 * - `auto` — a classifier decides each request instead of the user.
 * - `plan` — the agent may think and read but executes nothing.
 * - `manual` — the agent asks before anything consequential. The usual default.
 * - `accept-edits` — file edits go through unattended; other operations still ask.
 * - `dont-ask` — nothing is asked; anything not pre-approved is DENIED.
 * - `bypass` — nothing is asked; everything is ALLOWED.
 *
 * `dont-ask` and `bypass` are both "stops asking" and are opposites in what
 * that silence means, so they must never collapse into one another.
 */
export type CanonicalModeId = 'manual' | 'plan' | 'accept-edits' | 'auto' | 'dont-ask' | 'bypass'

export interface CanonicalModeInfo {
  id: CanonicalModeId
  /** Display label for surfaces that would rather not echo the agent's wording. */
  label: string
  /** What the mode does, in host-agnostic terms. */
  description: string
  /**
   * Position in the canonical menu order, ascending. Presentation order is a
   * product decision rather than something derivable — it is NOT a severity
   * ramp (`auto` leads while being far from the least permissive) — so it is
   * stated once here instead of re-derived, differently, by each surface.
   *
   * A surface sorts by this rather than by the agent's advertised order, so the
   * same mode sits in the same place whichever agent is behind the chat.
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
  manual: {
    id: 'manual',
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
  'dont-ask': {
    id: 'dont-ask',
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

/**
 * Per-adapter overrides, keyed by adapter id (see harness-adapters.ts) then by
 * the mode id the agent puts on the wire.
 *
 * Only spellings the generic normaliser below cannot reach need an entry —
 * Claude Code's `default` (advertised as "Manual", so the wire id says nothing
 * about the behaviour) and `bypassPermissions` (which normalises to
 * `bypasspermissions`, not `bypass`). The rest are here anyway, so this table
 * doubles as the readable record of what one agent actually offers.
 *
 * Verified against @agentclientprotocol/claude-agent-acp 0.66.0's
 * buildAvailableModes(). Two of those six are conditional: `auto` appears only
 * when the SDK reports the model supports it, and `bypassPermissions` only when
 * the bridge's ALLOW_BYPASS holds — so a session legitimately advertising four
 * modes is not a missing mapping.
 */
const ADAPTER_MODE_IDS: Record<string, Record<string, CanonicalModeId>> = {
  claude: {
    auto: 'auto',
    default: 'manual',
    acceptEdits: 'accept-edits',
    plan: 'plan',
    dontAsk: 'dont-ask',
    bypassPermissions: 'bypass',
  },
}
// Both Claude adapters drive the same bridge binary and therefore advertise the
// same modes — they differ only in how the request is billed.
ADAPTER_MODE_IDS['claude-subscription'] = ADAPTER_MODE_IDS.claude as Record<string, CanonicalModeId>

// Wire spellings that map to a canonical id for ANY adapter, so an agent that
// names its modes the obvious way is classified without a table entry. Keys are
// already normalised (lowercased, separators stripped).
const GENERIC_MODE_IDS: Record<string, CanonicalModeId> = {
  manual: 'manual',
  plan: 'plan',
  planning: 'plan',
  acceptedits: 'accept-edits',
  auto: 'auto',
  dontask: 'dont-ask',
  bypass: 'bypass',
  bypasspermissions: 'bypass',
}

function normalizeModeId(modeId: string): string {
  return modeId.toLowerCase().replace(/[-_\s]/g, '')
}

/**
 * Classify one agent-advertised mode id, or undefined when nothing recognises
 * it. Undefined is a normal answer, not a failure: an unknown mode is still a
 * real mode the session offers, and a caller should render it from the agent's
 * own `name`/`description` rather than hide it.
 *
 * The adapter table wins over the generic spellings so an agent that reuses a
 * common word for an uncommon behaviour can be corrected in one place.
 */
export function canonicalModeId(adapterId: string, modeId: string): CanonicalModeId | undefined {
  return ADAPTER_MODE_IDS[adapterId]?.[modeId] ?? GENERIC_MODE_IDS[normalizeModeId(modeId)]
}

/** A session mode paired with its classification, if it has one. */
export interface ClassifiedMode extends SessionMode {
  canonical?: CanonicalModeInfo
}

/**
 * Pair each of a session's advertised modes with its canonical classification.
 * Order and membership are the agent's — this never adds a mode the session did
 * not offer, and never drops one it did.
 */
export function classifyModes(adapterId: string, modes: SessionMode[]): ClassifiedMode[] {
  return modes.map((mode) => {
    const id = canonicalModeId(adapterId, mode.id)
    return id ? { ...mode, canonical: CANONICAL_MODES[id] } : { ...mode }
  })
}

/**
 * The wire id this session would use for a canonical mode, or undefined when it
 * does not offer one — the reverse of `canonicalModeId`, resolved against what
 * the session actually advertised rather than against the adapter table.
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
