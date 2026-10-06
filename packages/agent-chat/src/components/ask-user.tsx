'use client'

import { customAnswerTarget, isSecretField } from 'agent-client/elicitation-form'
import type { ElicitationContentValue, ElicitationSchema } from 'agent-client/types'
import { Check, ExternalLink, MessageCircleQuestion, X } from 'lucide-react'
import { type ComponentProps, type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Checkbox } from 'ui/components/ui/checkbox'
import { Input } from 'ui/components/ui/input'
import { Label } from 'ui/components/ui/label'
import { RadioGroup, RadioGroupItem } from 'ui/components/ui/radio-group'

import { Markdown } from './markdown'

// ── Schema folding ───────────────────────────────────────────────────────────
//
// THE ask-a-question component: agent-sent ACP form elicitations and the
// host's own ask_user tool both render here, one question per tab. The input
// is always an ElicitationSchema — hosts with a questions shape convert it
// first (agent-client/elicitation-form) — so there is exactly one renderer and
// one answer shape, and the two paths cannot drift apart.

/** One choice of a select or multi field. `label` and `description` are
 * markdown. */
export interface AskUserOption {
  value: string
  label: string
  description?: string
}

/** One tab: a question field, with its paired free-text "Other" box when the
 * schema marked one (see customAnswerTarget). */
export interface AskUserField {
  key: string
  title: string
  description?: string
  required: boolean
  // Typed masked. Set only when the schema marked the field (see
  // isSecretField), and likewise `customSecret` for its paired box, which
  // carries its own marker.
  secret?: true
  // The paired custom field's KEY — its answer travels under this key, apart
  // from the picks, exactly as the schema declared it.
  customKey?: string
  customSecret?: true
  kind:
    | { type: 'select'; options: AskUserOption[] }
    | { type: 'multi'; options: AskUserOption[] }
    | { type: 'boolean' }
    | { type: 'number'; integer: boolean }
    | { type: 'text' }
}

type PropertyRecord = Record<string, unknown>

function enumOptions(raw: unknown): AskUserOption[] | null {
  if (!Array.isArray(raw)) {
    return null
  }
  const options = raw.flatMap((entry) => {
    if (typeof entry === 'string') {
      return [{ value: entry, label: entry }]
    }
    if (entry && typeof entry === 'object' && typeof (entry as PropertyRecord).const === 'string') {
      const option = entry as { const: string; title?: unknown; description?: unknown }
      return [
        {
          value: option.const,
          label: typeof option.title === 'string' && option.title ? option.title : option.const,
          ...(typeof option.description === 'string' && option.description
            ? { description: option.description }
            : {}),
        },
      ]
    }
    return []
  })
  return options.length > 0 ? options : null
}

/**
 * Fold an elicitation schema into tabs. A field marked as another field's
 * custom-answer box folds INTO that field's tab; everything else becomes a tab
 * of its own. Unknown property types degrade to a text input rather than
 * vanishing — a field the reader cannot see is an answer the agent never gets.
 * For the same reason a box naming a question the schema does not have stays
 * a tab of its own.
 */
export function askFields(schema: ElicitationSchema): AskUserField[] {
  const required = new Set(schema.required ?? [])
  const properties = schema.properties ?? {}
  const entries = Object.entries(properties)
  const pairedTarget = (key: string, property: unknown): string | null => {
    const target = customAnswerTarget(key, property)
    return target !== null && Object.hasOwn(properties, target) ? target : null
  }
  // A plain record, not a Map: the design kit's live preview resolves bare
  // identifiers by name, and an icon called Map shadows the global there.
  const customFor: Record<string, string> = {}
  for (const [key, property] of entries) {
    const target = pairedTarget(key, property)
    if (target) {
      customFor[target] = key
    }
  }
  const fields: AskUserField[] = []
  for (const [key, property] of entries) {
    if (pairedTarget(key, property)) {
      continue
    }
    const record = property as PropertyRecord
    const title = typeof record.title === 'string' && record.title ? record.title : key
    const description = typeof record.description === 'string' && record.description ? record.description : undefined
    const customKey = Object.hasOwn(customFor, key) ? customFor[key] : undefined
    const base = {
      key,
      title,
      ...(description ? { description } : {}),
      required: required.has(key),
      ...(isSecretField(property) ? { secret: true as const } : {}),
      ...(customKey ? { customKey } : {}),
      ...(customKey && isSecretField(properties[customKey]) ? { customSecret: true as const } : {}),
    }
    if (record.type === 'string') {
      const options = enumOptions(record.oneOf) ?? enumOptions(record.enum)
      fields.push({ ...base, kind: options ? { type: 'select', options } : { type: 'text' } })
    } else if (record.type === 'array') {
      const items = (record.items ?? {}) as PropertyRecord
      const options = enumOptions(items.anyOf) ?? enumOptions(items.enum) ?? []
      fields.push({ ...base, kind: { type: 'multi', options } })
    } else if (record.type === 'boolean') {
      fields.push({ ...base, kind: { type: 'boolean' } })
    } else if (record.type === 'number' || record.type === 'integer') {
      fields.push({ ...base, kind: { type: 'number', integer: record.type === 'integer' } })
    } else {
      fields.push({ ...base, kind: { type: 'text' } })
    }
  }
  return fields
}

/** What the reader has entered so far, keyed by field key. Customs live in
 * `customs`, apart from the field's own value, because they answer under a
 * different content key. */
export interface AskUserState {
  values: Record<string, string | string[] | boolean>
  customs: Record<string, string>
}

function fieldAnswered(field: AskUserField, state: AskUserState): boolean {
  const value = state.values[field.key]
  const custom = (state.customs[field.key] ?? '').trim()
  switch (field.kind.type) {
    case 'select':
      return (typeof value === 'string' && value !== '') || custom !== ''
    case 'multi':
      return (Array.isArray(value) && value.length > 0) || custom !== ''
    case 'boolean':
      // Unchecked IS an answer: the content always carries true or false.
      return true
    default:
      return typeof value === 'string' && value.trim() !== ''
  }
}

/**
 * The accept-content for the current inputs, or null while a required field is
 * unanswered or a number does not parse. One function for the submit gate and
 * the payload, so the button can never enable on inputs the payload would drop.
 */
export function buildAskContent(
  fields: AskUserField[],
  state: AskUserState,
): Record<string, ElicitationContentValue> | null {
  const content: Record<string, ElicitationContentValue> = {}
  for (const field of fields) {
    const value = state.values[field.key]
    const custom = (state.customs[field.key] ?? '').trim()
    if (field.required && !fieldAnswered(field, state)) {
      return null
    }
    switch (field.kind.type) {
      case 'select': {
        if (typeof value === 'string' && value !== '') {
          content[field.key] = value
        }
        break
      }
      case 'multi': {
        if (Array.isArray(value) && value.length > 0) {
          content[field.key] = value
        }
        break
      }
      case 'boolean': {
        content[field.key] = value === true
        break
      }
      case 'number': {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text === '') {
          break
        }
        const parsed = Number(text)
        if (Number.isNaN(parsed) || (field.kind.integer && !Number.isInteger(parsed))) {
          return null
        }
        content[field.key] = parsed
        break
      }
      default: {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text !== '') {
          content[field.key] = text
        }
        break
      }
    }
    if (field.customKey && custom !== '') {
      content[field.customKey] = custom
    }
  }
  return content
}

// ── The component ────────────────────────────────────────────────────────────

// One choice: the control, then its label over its description, both markdown.
// They sit inside the option's <label>, so they render inline (a label holds
// phrasing content only), and the label takes the rest of the row, so a press
// anywhere on the row picks the option. A link or a reference chip in the text
// does not: a label's activation skips clicks whose target is interactive
// content inside it, which an <a href> and a <button> are.
function OptionRow({ id, option, control }: { id: string; option: AskUserOption; control: ReactNode }) {
  return (
    <div className='flex items-start'>
      <span className='flex h-5 shrink-0 items-center'>{control}</span>
      <Label htmlFor={id} className='flex-1 cursor-pointer flex-col items-start gap-0.5 pl-2 text-sm leading-5 font-normal'>
        <span className='min-w-0 wrap-break-word'>
          <Markdown text={option.label} typography='inherit' inline />
        </span>
        {option.description ? (
          <span className='min-w-0 text-xs text-muted-foreground wrap-break-word'>
            <Markdown text={option.description} typography='inherit' inline />
          </span>
        ) : null}
      </Label>
    </div>
  )
}

export interface AskUserProps {
  // The elicitation's own message — the question itself for a single-field
  // form, the "please answer" preamble for several.
  message?: string
  schema: ElicitationSchema
  onSubmit: (content: Record<string, ElicitationContentValue>) => void
  onCancel?: () => void
  // Disables actions while an answer/cancel is in flight (host-controlled).
  pending?: boolean
}

export function AskUser({ message, schema, onSubmit, onCancel, pending = false }: AskUserProps) {
  const [currentIdx, setCurrentIdx] = useState(0)
  const [state, setState] = useState<AskUserState>({ values: {}, customs: {} })
  // Set while focus is moving onto something in the radio group; read by its
  // click handler below.
  const radioTakingFocus = useRef(false)
  const fields = askFields(schema)
  const field = fields[Math.min(currentIdx, fields.length - 1)]
  if (!field) {
    return null
  }
  const isLast = currentIdx >= fields.length - 1
  const content = buildAskContent(fields, state)
  const setValue = (key: string, value: string | string[] | boolean) =>
    setState((prev) => ({ ...prev, values: { ...prev.values, [key]: value } }))
  const setCustom = (key: string, value: string) =>
    setState((prev) => ({ ...prev, customs: { ...prev.customs, [key]: value } }))

  const advance = () => {
    if (isLast) {
      if (content) {
        onSubmit(content)
      }
    } else {
      setCurrentIdx((index) => index + 1)
    }
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      advance()
    }
  }

  const picks = Array.isArray(state.values[field.key]) ? (state.values[field.key] as string[]) : []
  const picked = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string) : ''
  const customText = state.customs[field.key] ?? ''

  // Pressing the picked option again clears it, so a question with a custom
  // answer box can be answered by the box alone. A press on the option's row,
  // on its control, or Space on the control all end as a click on the radio's
  // hidden <input>, which keeps that click from bubbling: so this listens on
  // the way down. The radio also clicks that input itself as it takes focus
  // during Arrow navigation, which is not a press: a click during a radio's
  // focus never unpicks.
  const onRadioClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (
      !radioTakingFocus.current &&
      target instanceof HTMLInputElement &&
      target.type === 'radio' &&
      picked !== '' &&
      target.value === picked
    ) {
      setValue(field.key, '')
    }
  }

  // An Arrow key makes the group remember to pick whichever radio takes focus
  // next, which is how Arrow navigation picks. When the Arrow cannot move
  // focus (Ctrl, Alt or Meta held, or no other option to move to), nothing
  // takes focus and the request would wait for whatever focus comes next: Tab
  // back onto the group, or a press on an option's text. Such an Arrow is
  // kept from the group, so focus alone never changes the answer.
  const onRadioKeyDownCapture: ComponentProps<typeof RadioGroup>['onKeyDownCapture'] = (event) => {
    if (!event.key.startsWith('Arrow')) {
      return
    }
    const modified = (['Control', 'Alt', 'Meta'] as const).some((key) => event.getModifierState(key))
    const options = event.currentTarget.querySelectorAll('[role="radio"]:not([data-disabled])').length
    if (modified || options < 2) {
      event.preventBaseUIHandler()
    }
  }

  return (
    <div className='flex flex-col gap-2 px-3 py-2'>
      {/* Header */}
      <div className='flex items-center gap-2'>
        <MessageCircleQuestion className='h-4 w-4 shrink-0 text-primary' />
        <div className='min-w-0 flex-1 text-sm font-medium wrap-break-word'>
          <Markdown text={message || 'Questions'} typography='inherit' />
        </div>
        {onCancel ? (
          <Button size='sm' variant='ghost' onClick={onCancel} disabled={pending} className='h-6 w-6 p-0'>
            <X className='h-4 w-4' />
          </Button>
        ) : null}
      </div>

      {/* Tabs — one per question; hidden when there is only one */}
      {fields.length > 1 ? (
        <div className='-mx-3 flex items-center gap-0 border-b px-3'>
          {fields.map((entry, idx) => (
            <button
              key={entry.key}
              type='button'
              onClick={() => setCurrentIdx(idx)}
              className={[
                'flex items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-xs font-medium transition-colors',
                currentIdx === idx
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground/80',
              ].join(' ')}
            >
              {fieldAnswered(entry, state) && entry.kind.type !== 'boolean' && (
                <Check className='size-3 text-primary' />
              )}
              {entry.title}
            </button>
          ))}
        </div>
      ) : null}

      {/* Question text */}
      {field.description ? (
        <div className='text-sm text-muted-foreground'>
          <Markdown text={field.description} typography='inherit' />
        </div>
      ) : null}

      {/* Field body */}
      {field.kind.type === 'select' ? (
        <RadioGroup
          value={picked}
          onValueChange={(value) => setValue(field.key, value)}
          onKeyDownCapture={onRadioKeyDownCapture}
          onFocusCapture={() => {
            radioTakingFocus.current = true
          }}
          onFocus={() => {
            radioTakingFocus.current = false
          }}
          onClickCapture={onRadioClickCapture}
          className='gap-1.5'
        >
          {field.kind.options.map((option) => {
            const id = `${field.key}-${option.value}`
            return (
              <OptionRow
                key={option.value}
                id={id}
                option={option}
                control={<RadioGroupItem value={option.value} id={id} />}
              />
            )
          })}
        </RadioGroup>
      ) : field.kind.type === 'multi' ? (
        <div className='flex flex-col gap-1.5'>
          {field.kind.options.map((option) => {
            const checked = picks.includes(option.value)
            const id = `${field.key}-${option.value}`
            return (
              <OptionRow
                key={option.value}
                id={id}
                option={option}
                control={
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() =>
                      setValue(
                        field.key,
                        checked ? picks.filter((pick) => pick !== option.value) : [...picks, option.value],
                      )
                    }
                  />
                }
              />
            )
          })}
        </div>
      ) : field.kind.type === 'boolean' ? (
        <div className='flex items-center gap-2'>
          <Checkbox
            id={field.key}
            checked={state.values[field.key] === true}
            onCheckedChange={(checked) => setValue(field.key, checked === true)}
          />
          <Label htmlFor={field.key} className='cursor-pointer text-sm font-normal'>
            {field.title}
          </Label>
        </div>
      ) : (
        <Input
          type={field.secret ? 'password' : undefined}
          autoComplete={field.secret ? 'off' : undefined}
          value={typeof state.values[field.key] === 'string' ? (state.values[field.key] as string) : ''}
          onChange={(event) => setValue(field.key, event.target.value)}
          onKeyDown={onInputKeyDown}
          inputMode={field.kind.type === 'number' ? 'decimal' : undefined}
          placeholder={field.required ? 'Required' : 'Optional'}
          className='h-8'
        />
      )}

      {/* The question's own "Other" box, when the schema declared one */}
      {field.customKey ? (
        <Input
          type={field.customSecret ? 'password' : undefined}
          autoComplete={field.customSecret ? 'off' : undefined}
          value={customText}
          onChange={(event) => setCustom(field.key, event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder='Custom answer (optional)'
          className='mt-1 h-8'
        />
      ) : null}

      {/* Next / Submit */}
      <Button size='sm' onClick={advance} disabled={pending || (isLast && !content)} className='w-full'>
        {isLast ? 'Submit' : 'Next'}
      </Button>
    </div>
  )
}

// ── URL elicitation ─────────────────────────────────────────────────────────

export interface AskUrlProps {
  message: string
  url: string
  // Done = accept with nothing to say; the agent's own completion
  // notification usually resolves the ask before anyone presses it.
  onDone: () => void
  onCancel: () => void
}

/** An ACP url elicitation: visit the link, then Done — or the agent notices
 * the out-of-band step finished and resolves this itself. */
export function AskUrl({ message, url, onDone, onCancel }: AskUrlProps) {
  return (
    <div className='flex flex-col gap-2 rounded-md border p-3 text-sm'>
      <div className='flex items-start gap-2'>
        <MessageCircleQuestion className='mt-0.5 size-4 shrink-0 text-primary' />
        <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-break-word'>{message}</span>
      </div>
      <div className='flex items-center gap-2'>
        {/* biome-ignore lint/a11y/useAnchorContent: the anchor is the element the Button renders AS -- its content is the Button's children below, which Base UI's render merges into it */}
        <Button size='sm' render={<a href={url} target='_blank' rel='noreferrer noopener' />} nativeButton={false}>
          <ExternalLink className='size-3.5' />
          Open
        </Button>
        <Button size='sm' variant='outline' onClick={onDone}>
          Done
        </Button>
        <Button size='sm' variant='ghost' onClick={onCancel}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
