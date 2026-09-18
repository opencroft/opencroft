'use client'

import { AGENT_PROVIDERS } from 'agent-client/agent-providers'
import type { AgentProfile } from 'agent-client/profiles'
import { reasoningEfforts } from 'agent-client/reasoning'
import { adaptersForProvider, findAdapter, findProvider } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from 'ui/components/ui/button'
import { Field, FieldDescription, FieldLabel } from 'ui/components/ui/field'
import { ControlledInput } from 'ui/components/ui/input/controlled-input'
import { ControlledTextarea } from 'ui/components/ui/input/controlled-textarea'
import { SearchableDropdown } from 'ui/components/ui/input/searchable-dropdown'
import { Flex } from 'ui/components/ui/layout/flex'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/components/ui/select'

// The default empty selection — a convenient starting point for new presets.
export const EMPTY_SELECTION: AgentSelection = {
  providerId: '',
  adapterId: '',
  model: '',
  apiKey: '',
  cwd: '',
  baseUrl: '',
}

// Returns true once a selection has enough set to start a session.
export function canStartSelection(selection: AgentSelection): boolean {
  const provider = findProvider(selection.providerId)
  const isCustomEndpoint = selection.providerId === 'openai-compatible'
  const needsModel = Boolean(provider && (provider.models.length || isCustomEndpoint))
  return Boolean(
    selection.providerId &&
      selection.adapterId &&
      (!needsModel || selection.model) &&
      (!isCustomEndpoint || selection.baseUrl),
  )
}

export interface AgentProfilePickerProps {
  profiles: AgentProfile[]
  activeId: string
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: () => void
}

// The profile Select + new/delete row. Pairs with <AgentPresetForm> to edit the
// selected preset.
export function AgentProfilePicker({ profiles, activeId, onSelect, onCreate, onDelete }: AgentProfilePickerProps) {
  return (
    <Field>
      <FieldLabel>Profile</FieldLabel>
      <Flex row className='gap-2'>
        <Select value={activeId} onValueChange={onSelect}>
          <SelectTrigger className='w-full'>
            <SelectValue placeholder='Select profile' />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant='outline' size='icon' onClick={onCreate} title='New profile'>
          <Plus />
        </Button>
        <Button variant='outline' size='icon' onClick={onDelete} disabled={profiles.length <= 1} title='Delete profile'>
          <Trash2 />
        </Button>
      </Flex>
    </Field>
  )
}

export interface AgentPresetFormProps {
  // Editable preset name.
  name: string
  onNameChange: (name: string) => void
  // The selection being edited; `onSelectionChange` receives a partial patch.
  selection: AgentSelection
  onSelectionChange: (patch: Partial<AgentSelection>) => void
  // Model discovery for OpenAI-compatible custom endpoints.
  loadedModels?: string[]
  loadingModels?: boolean
  onLoadModels?: () => void
  // Roles the profile can be assigned (tool/skill permissions). When omitted or
  // empty, the roles selector is hidden.
  roles?: { id: string; name: string }[]
  roleIds?: string[]
  onRoleIdsChange?: (roleIds: string[]) => void
  // Optional save action; renders a Save button at the bottom when provided.
  onSave?: () => void
}

// Edits a single agent preset: provider, harness, model, key, and (for the
// in-process native harness) system prompt / reasoning / temperature. Fully
// controlled — the host owns the selection state and persistence.
export function AgentPresetForm({
  name,
  onNameChange,
  selection,
  onSelectionChange,
  loadedModels = [],
  loadingModels = false,
  onLoadModels,
  roles = [],
  roleIds = [],
  onRoleIdsChange,
  onSave,
}: AgentPresetFormProps) {
  const toggleRole = (id: string) =>
    onRoleIdsChange?.(roleIds.includes(id) ? roleIds.filter((r) => r !== id) : [...roleIds, id])
  const provider = findProvider(selection.providerId)
  const adapters = adaptersForProvider(selection.providerId)
  const isCustomEndpoint = selection.providerId === 'openai-compatible'
  // The adapter's KIND, not its id. These agree today because exactly one
  // adapter carries `kind: 'native'` and happens to be spelled `native` too --
  // but `native` is overloaded in this file's own vocabulary, since five
  // adapters carry `protocol: 'native'` and are not the in-process harness. The
  // agreement is a coincidence the next adapter can break.
  //
  // It matters more than it did. As a gate this only had to be conservative;
  // it now also picks the context-window placeholder, which is a claim about
  // what `knownContextWindow` will do with an empty field. That has to match
  // that function exactly, and `findAdapter(...).kind` is the test it makes.
  const isNative = findAdapter(selection.adapterId)?.kind === 'native'
  // Reasoning support: detected from the model for the native harness; for ACP
  // agents it's advertised at session start, so offer a generic scale.
  const reasoningOptions = isNative
    ? reasoningEfforts(selection.model)
    : selection.adapterId
      ? ['low', 'medium', 'high']
      : []

  return (
    <Flex withGaps>
      <Field>
        <FieldLabel>Name</FieldLabel>
        <ControlledInput value={name} onValueChanged={onNameChange} placeholder='Profile name' />
      </Field>

      <Field>
        <FieldLabel>Provider</FieldLabel>
        <Select
          value={selection.providerId}
          onValueChange={(value) => onSelectionChange({ providerId: value, adapterId: '', model: '' })}
        >
          <SelectTrigger className='w-full'>
            <SelectValue placeholder='Select provider' />
          </SelectTrigger>
          <SelectContent>
            {AGENT_PROVIDERS.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel>Harness</FieldLabel>
        <Select
          value={selection.adapterId}
          onValueChange={(value) => onSelectionChange({ adapterId: value })}
          disabled={!adapters.length}
        >
          <SelectTrigger className='w-full'>
            <SelectValue placeholder='Select harness' />
          </SelectTrigger>
          <SelectContent>
            {adapters.map((adapter) => (
              <SelectItem key={adapter.id} value={adapter.id}>
                {adapter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {isCustomEndpoint ? (
        <>
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <ControlledInput
              value={selection.baseUrl ?? ''}
              onValueChanged={(value) => onSelectionChange({ baseUrl: value })}
              placeholder='https://api.openai.com/v1'
            />
          </Field>
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Flex row className='gap-2'>
              <SearchableDropdown
                className='flex-1'
                value={selection.model}
                onChange={(value) => onSelectionChange({ model: value })}
                options={loadedModels}
                allowCustom
                placeholder={loadedModels.length ? 'Select or type model' : 'Type a model…'}
              />
              <Button
                variant='outline'
                size='icon'
                onClick={onLoadModels}
                disabled={!selection.baseUrl || loadingModels || !onLoadModels}
                title='Load models from /models'
              >
                {loadingModels ? <Loader2 className='animate-spin' /> : <RefreshCw />}
              </Button>
            </Flex>
          </Field>
        </>
      ) : (
        !!provider?.models.length && (
          <Field>
            <FieldLabel>Model</FieldLabel>
            <SearchableDropdown
              value={selection.model}
              onChange={(value) => onSelectionChange({ model: value })}
              options={provider.models}
              allowCustom
              placeholder='Select or type model'
            />
          </Field>
        )
      )}

      <Field>
        <FieldLabel>API key</FieldLabel>
        <ControlledInput
          type='password'
          value={selection.apiKey}
          onValueChanged={(value) => onSelectionChange({ apiKey: value })}
          placeholder='Provider / harness auth token'
        />
      </Field>

      {roles.length > 0 && (
        <Field>
          <FieldLabel>Roles</FieldLabel>
          <Flex row className='flex-wrap gap-1.5'>
            {roles.map((role) => (
              <Button
                key={role.id}
                type='button'
                size='sm'
                variant={roleIds.includes(role.id) ? 'default' : 'outline'}
                onClick={() => toggleRole(role.id)}
              >
                {role.name}
              </Button>
            ))}
          </Flex>
        </Field>
      )}

      {isNative && (
        <Field>
          <FieldLabel>System prompt</FieldLabel>
          <ControlledTextarea
            value={selection.systemPrompt ?? ''}
            onValueChanged={(value) => onSelectionChange({ systemPrompt: value })}
            placeholder='Optional — leave empty for none'
            rows={5}
            className='text-xs resize-none'
          />
        </Field>
      )}

      {reasoningOptions.length > 0 && (
        <Field>
          <FieldLabel>Reasoning</FieldLabel>
          <Select
            value={selection.reasoningEffort || 'off'}
            // Store 'off' literally so an explicit choice survives — leaving it
            // as '' would be indistinguishable from "unset", which claude
            // adapters now default to 'medium' (see resolveReasoningEffort in
            // agent-client.ts). Existing profiles with '' still mean "unset"
            // and pick up that new default, which is the intended migration.
            onValueChange={(value) => onSelectionChange({ reasoningEffort: value })}
          >
            <SelectTrigger className='w-full'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='off'>Off</SelectItem>
              {reasoningOptions.map((level) => (
                <SelectItem key={level} value={level}>
                  {level[0].toUpperCase() + level.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      {isNative && (
        <Field>
          <FieldLabel>Temperature</FieldLabel>
          <ControlledInput
            type='number'
            value={selection.temperature?.toString() ?? ''}
            onValueChanged={(value) => {
              const parsed = Number(value)
              onSelectionChange({
                temperature: value.trim() === '' || Number.isNaN(parsed) ? undefined : parsed,
              })
            }}
            placeholder='Provider default'
          />
        </Field>
      )}

      {/* Shown for every harness, because a configured window is the FIRST
          authority `knownContextWindow` consults and it does not ask which
          adapter is in use. Since 2026-09-18 the harness-reported size is the
          trusted fallback for every harness, so this field is the OVERRIDE —
          pin a window when the harness's own figure is wrong or absent — not
          the only source it once was while bridged sizes were withheld.

          Left empty, the endpoint is asked — but most cannot answer. Neither
          the OpenAI nor the Anthropic models route carries a context length,
          and a llama.cpp router reports none until an instance is up. A wrong
          value is worse than none, which is why nothing is guessed from the
          model name to fill it.

          THERE IS A SECOND FIELD FOR THE SAME VALUE. The agent node's own
          Inspector (core's `nodes/agent.tsx`, `ContextWindowField`) writes the
          same `contextWindow`, and in the opencroft app that one is the surface
          a person actually reaches — this form is not mounted there. Ungating
          this one alone left the defect exactly as it was, from the user's side,
          because the reachable copy kept its harness gate. If a harness gate is
          ever argued for again, it has to be argued for in both places at once,
          or the two disagree and only one of them is visible. */}
      <Field>
        <FieldLabel>Max context</FieldLabel>
        <ControlledInput
          type='number'
          value={selection.contextWindow?.toString() ?? ''}
          onValueChanged={(value) => {
            const parsed = Number(value)
            onSelectionChange({
              contextWindow: value.trim() === '' || !Number.isInteger(parsed) || parsed <= 0 ? undefined : parsed,
            })
          }}
          placeholder={isNative ? 'Ask the endpoint' : 'Unknown'}
        />
        <FieldDescription>
          Tokens. Leave empty to use the window the harness reports; set it to override that figure, or when the
          harness reports none — the context ring shows a bare token count without one.
        </FieldDescription>
      </Field>

      {onSave && (
        <Flex row justify='end'>
          <Button size='sm' onClick={onSave}>
            Save
          </Button>
        </Flex>
      )}
    </Flex>
  )
}
