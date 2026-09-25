// The command bar's config-option classification: which options get their own
// icon button (never a leftover row) and the two leftover-selection functions
// themselves. Split out of agent-command-bar.tsx so this logic is testable
// without the whole hook's React/UI import chain (agent-command-bar.test.ts
// imports from here, not from the hook file).
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  type ConfigSelector,
  FAST_MODE_SELECTOR,
  findConfigOption,
  MODE_SELECTOR,
  MODEL_SELECTOR,
  THOUGHT_LEVEL_SELECTOR,
} from 'agent-client/config-selectors'

import type { CommandBarConfig, CommandBarConfigOption } from './components/agent-command-bar'

// Each own-button control is found by what the option MEANS -- its ACP
// category -- and only then by the id below, which is the conventional
// spelling for an agent that sends no category. Keyed on the id alone, an
// agent that spells the same setting differently (codex-acp's
// `reasoning_effort` and `fast-mode`) lost the control and had the setting
// dumped among the leftovers instead. The ids stay exported because a host
// pins a control (`lockedConfigOptions`) by this conventional name: it cannot
// know what a given agent calls the option.
//
// The permission mode. ACP delivers modes twice -- as session modes AND as
// this option, built from the same list -- and this surface drives the
// option, so it is the handle for both pulling it out of the generic row and
// locking it.
export const MODE_CONFIG_ID = MODE_SELECTOR.id
// Reasoning effort: rendered as its own icon button rather than a labelled
// dropdown. Unlike `mode`, the values behind this vary per model -- the agent
// decides what it advertises, and it may advertise none.
export const EFFORT_CONFIG_ID = THOUGHT_LEVEL_SELECTOR.id
// The model itself. Unlike mode/effort, a model's values have no small closed
// vocabulary to canonicalize -- the wire label is shown as-is.
export const MODEL_CONFIG_ID = MODEL_SELECTOR.id
// Fast mode, which an agent advertises per model -- absent entirely for a model
// that cannot do it. Delivered as a native boolean where the client supports
// one and as a two-value on/off select otherwise, so both shapes are read here.
// Its description is always present and carries the reason when the setting
// cannot currently be honoured, so it is shown on hover rather than used to
// infer a disabled state the wire never states.
export const FAST_MODE_CONFIG_ID = FAST_MODE_SELECTOR.id
export const FAST_MODE_ON = 'on'
export const FAST_MODE_OFF = 'off'

// Kept here, not only in the ids above, so the button and the leftover filter
// resolve through one table and cannot disagree about which option is which.
const OWN_BUTTON_SELECTORS = {
  mode: MODE_SELECTOR,
  effort: THOUGHT_LEVEL_SELECTOR,
  model: MODEL_SELECTOR,
  fast: FAST_MODE_SELECTOR,
} satisfies Record<string, ConfigSelector>

export type OwnButtonOptions = Record<keyof typeof OWN_BUTTON_SELECTORS, SessionConfigOption | undefined>

// The option behind each own-button control, or undefined where the agent
// offers none.
export function selectOwnButtonOptions(configOptions: SessionConfigOption[] | undefined): OwnButtonOptions {
  return {
    mode: findConfigOption(configOptions, OWN_BUTTON_SELECTORS.mode),
    effort: findConfigOption(configOptions, OWN_BUTTON_SELECTORS.effort),
    model: findConfigOption(configOptions, OWN_BUTTON_SELECTORS.model),
    fast: findConfigOption(configOptions, OWN_BUTTON_SELECTORS.fast),
  }
}

// Every option rendered as its own icon button, in EITHER wire shape it might
// arrive in (boolean or select) -- never as one more leftover row in the
// settings dropdown or a leftover chip next to the ring. Derived from the one
// resolution above so a control is excluded from leftovers exactly when it
// has a button: fast mode originally excluded only the select shape, leaving
// its boolean form duplicated in both places at once.
function ownButtonIds(configOptions: SessionConfigOption[] | undefined): Set<string> {
  return new Set(Object.values(selectOwnButtonOptions(configOptions)).flatMap((option) => (option ? [option.id] : [])))
}

// A config option's values can be a flat list or grouped under labeled
// sections — flatten to the { value, label } pairs the command bar's settings
// dropdown takes.
export function flattenOptions(options: unknown): CommandBarConfigOption[] {
  const flat: CommandBarConfigOption[] = []
  if (!Array.isArray(options)) {
    return flat
  }
  for (const entry of options as Array<Record<string, unknown>>) {
    if (Array.isArray(entry.options)) {
      for (const option of entry.options as Array<{ name?: string; value?: string }>) {
        if (typeof option.value === 'string') {
          flat.push({ value: option.value, label: option.name ?? option.value })
        }
      }
    } else if (typeof entry.value === 'string' && typeof entry.name === 'string') {
      flat.push({ value: entry.value, label: entry.name })
    }
  }
  return flat
}

// The settings dropdown's leftover rows: every config option NOT rendered as
// its own icon button, in the select shape (a native boolean has no `.options`
// list to show as a dropdown row at all, so it is excluded by type before the
// id check ever runs -- see selectLeftoverBooleanOptions for its shape).
export function selectLeftoverConfigs(configOptions: SessionConfigOption[] | undefined): CommandBarConfig[] {
  const own = ownButtonIds(configOptions)
  return (
    (configOptions ?? [])
      // Two filters rather than one condition: TypeScript infers a type
      // predicate from the bare `type !== 'boolean'` test and narrows the
      // array to the select variants, which the `.options` read below needs.
      // Folding a second condition into it silently loses that inference.
      .filter((option) => option.type !== 'boolean')
      .filter((option) => !own.has(option.id))
      .map((option) => ({
        id: option.id,
        label: option.name,
        value: String(option.currentValue ?? ''),
        options: flattenOptions(option.options),
      }))
  )
}

// The leftover boolean toggles rendered next to the ring: the same exclusion
// as selectLeftoverConfigs above, for the shape a native boolean arrives in
// instead.
export function selectLeftoverBooleanOptions(configOptions: SessionConfigOption[] | undefined): SessionConfigOption[] {
  const own = ownButtonIds(configOptions)
  return (configOptions ?? []).filter((option) => option.type === 'boolean' && !own.has(option.id))
}

// A mode option's values as modes, `_meta` included: codex-acp states on each
// value what the mode does (`_meta.kind`), which classifies it more reliably
// than its id -- see agent-client's canonicalModeOf. Flat or grouped, like
// flattenOptions.
export function modeEntries(options: unknown): Array<{ id: string; _meta?: Record<string, unknown> }> {
  if (!Array.isArray(options)) {
    return []
  }
  const values = (options as Array<Record<string, unknown>>).flatMap((entry) =>
    Array.isArray(entry.options) ? (entry.options as Array<Record<string, unknown>>) : [entry],
  )
  return values.flatMap((value) =>
    typeof value.value === 'string'
      ? [
          {
            id: value.value,
            ...(value._meta && typeof value._meta === 'object'
              ? { _meta: value._meta as Record<string, unknown> }
              : {}),
          },
        ]
      : [],
  )
}
