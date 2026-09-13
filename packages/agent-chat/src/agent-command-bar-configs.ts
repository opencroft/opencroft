// The command bar's config-option classification: which ids get their own
// icon button (never a leftover row) and the two leftover-selection functions
// themselves. Split out of agent-command-bar.tsx so this logic is testable
// without the whole hook's React/UI import chain (agent-command-bar.test.ts
// imports from here, not from the hook file).
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

import type { CommandBarConfig, CommandBarConfigOption } from './components/agent-command-bar'

// The config-option id agents use for the permission mode. ACP delivers modes
// twice -- as session modes AND as this option, built from the same list -- and
// this surface drives the option, so the id is the handle for both pulling it
// out of the generic row and locking it.
export const MODE_CONFIG_ID = 'mode'
// Likewise for reasoning effort: rendered as its own icon button rather than a
// labelled dropdown. Unlike `mode`, the values behind this vary per model — the
// agent decides what it advertises, and it may advertise none.
export const EFFORT_CONFIG_ID = 'effort'
// Likewise for the model itself. Unlike mode/effort, a model's values have no
// small closed vocabulary to canonicalize -- the wire label is shown as-is.
export const MODEL_CONFIG_ID = 'model'
// Fast mode, which an agent advertises per model — absent entirely for a model
// that cannot do it. Delivered as a native boolean where the client supports
// one and as a two-value on/off select otherwise, so both shapes are read here.
// Its description is always present and carries the reason when the setting
// cannot currently be honoured, so it is shown on hover rather than used to
// infer a disabled state the wire never states.
export const FAST_MODE_CONFIG_ID = 'fast'
export const FAST_MODE_ON = 'on'
export const FAST_MODE_OFF = 'off'

// Every config id rendered as its own icon button above, in EITHER wire shape
// it might arrive in (boolean or select) -- never as one more leftover row in
// the settings dropdown or a leftover chip next to the ring. One shared set
// so a future own-button control needs excluding from leftovers exactly once,
// not once per shape: fast mode originally excluded only the select shape,
// leaving its boolean form duplicated in both places at once.
const OWN_BUTTON_CONFIG_IDS = new Set([MODE_CONFIG_ID, EFFORT_CONFIG_ID, MODEL_CONFIG_ID, FAST_MODE_CONFIG_ID])

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
  return (configOptions ?? [])
    // Two filters rather than one condition: TypeScript infers a type
    // predicate from the bare `type !== 'boolean'` test and narrows the
    // array to the select variants, which the `.options` read below needs.
    // Folding a second condition into it silently loses that inference.
    .filter((option) => option.type !== 'boolean')
    .filter((option) => !OWN_BUTTON_CONFIG_IDS.has(option.id))
    .map((option) => ({
      id: option.id,
      label: option.name,
      value: String(option.currentValue ?? ''),
      options: flattenOptions(option.options),
    }))
}

// The leftover boolean toggles rendered next to the ring: the same exclusion
// as selectLeftoverConfigs above, for the shape a native boolean arrives in
// instead.
export function selectLeftoverBooleanOptions(configOptions: SessionConfigOption[] | undefined): SessionConfigOption[] {
  return (configOptions ?? []).filter((option) => option.type === 'boolean' && !OWN_BUTTON_CONFIG_IDS.has(option.id))
}
