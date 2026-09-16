'use client'

import { CUSTOM_ANSWER_META_KEY } from 'agent-client/elicitation-form'
import type { ElicitationContentValue, ElicitationSchema } from 'agent-client/types'
import { Check, ExternalLink, MessageCircleQuestion, X } from 'lucide-react'
import { type KeyboardEvent, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Checkbox } from 'ui/components/ui/checkbox'
import { Input } from 'ui/components/ui/input'
import { Label } from 'ui/components/ui/label'
import { RadioGroup, RadioGroupItem } from 'ui/components/ui/radio-group'

// ── Schema folding ───────────────────────────────────────────────────────────
//
// THE ask-a-question component: agent-sent ACP form elicitations and the
// host's own ask_user tool both render here, one question per tab. The input
// is always an ElicitationSchema — hosts with a questions shape convert it
// first (agent-client/elicitation-form) — so there is exactly one renderer and
// one answer shape, and the two paths cannot drift apart.

/** One tab: a question field, with its paired free-text "Other" box when the
 * schema marked one (see CUSTOM_ANSWER_META_KEY). */
export interface AskUserField {
  key: string
  title: string
  description?: string
  required: boolean
  // The paired custom field's KEY — its answer travels under this key, apart
  // from the picks, exactly as the schema declared it.
  customKey?: string
  kind:
    | { type: 'select'; options: { value: string; label: string; description?: string }[] }
    | { type: 'multi'; options: { value: string; label: string; description?: string }[] }
    | { type: 'boolean' }
    | { type: 'number'; integer: boolean }
    | { type: 'text' }
}

type PropertyRecord = Record<string, unknown>

function enumOptions(raw: unknown): { value: string; label: string; description?: string }[] | null {
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

function customAnswerTarget(property: unknown): string | null {
  const meta = (property as { _meta?: Record<string, unknown> | null })?._meta
  const marker = meta?.[CUSTOM_ANSWER_META_KEY] as { questionId?: unknown; isCustomAnswer?: unknown } | undefined
  return marker?.isCustomAnswer === true && typeof marker.questionId === 'string' ? marker.questionId : null
}

/**
 * Fold an elicitation schema into tabs. A field marked as another field's
 * custom-answer box folds INTO that field's tab; everything else becomes a tab
 * of its own. Unknown property types degrade to a text input rather than
 * vanishing — a field the reader cannot see is an answer the agent never gets.
 */
export function askFields(schema: ElicitationSchema): AskUserField[] {
  const required = new Set(schema.required ?? [])
  const entries = Object.entries(schema.properties ?? {})
  const customFor = new Map<string, string>()
  for (const [key, property] of entries) {
    const target = customAnswerTarget(property)
    if (target) {
      customFor.set(target, key)
    }
  }
  const fields: AskUserField[] = []
  for (const [key, property] of entries) {
    if (customAnswerTarget(property)) {
      continue
    }
    const record = property as PropertyRecord
    const title = typeof record.title === 'string' && record.title ? record.title : key
    const description = typeof record.description === 'string' && record.description ? record.description : undefined
    const customKey = customFor.get(key)
    const base = {
      key,
      title,
      ...(description ? { description } : {}),
      required: required.has(key),
      ...(customKey ? { customKey } : {}),
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
  const customText = state.customs[field.key] ?? ''

  return (
    <div className='flex flex-col gap-2 px-3 py-2'>
      {/* Header */}
      <div className='flex items-center gap-2'>
        <MessageCircleQuestion className='h-4 w-4 shrink-0 text-primary' />
        <span className='min-w-0 flex-1 text-sm font-medium wrap-break-word'>{message || 'Questions'}</span>
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
      {field.description ? <div className='text-sm text-muted-foreground'>{field.description}</div> : null}

      {/* Field body */}
      {field.kind.type === 'select' ? (
        <RadioGroup
          value={typeof state.values[field.key] === 'string' ? (state.values[field.key] as string) : ''}
          onValueChange={(value) => setValue(field.key, value)}
          className='gap-1.5'
        >
          {field.kind.options.map((option) => (
            <div key={option.value} className='flex items-center gap-2'>
              <RadioGroupItem value={option.value} id={`${field.key}-${option.value}`} />
              <Label htmlFor={`${field.key}-${option.value}`} className='cursor-pointer text-sm font-normal'>
                {option.label}
                {option.description ? (
                  <span className='ml-1 text-xs text-muted-foreground'>{option.description}</span>
                ) : null}
              </Label>
            </div>
          ))}
        </RadioGroup>
      ) : field.kind.type === 'multi' ? (
        <div className='flex flex-col gap-1.5'>
          {field.kind.options.map((option) => {
            const checked = picks.includes(option.value)
            return (
              <div key={option.value} className='flex items-center gap-2'>
                <Checkbox
                  id={`${field.key}-${option.value}`}
                  checked={checked}
                  onCheckedChange={() =>
                    setValue(
                      field.key,
                      checked ? picks.filter((pick) => pick !== option.value) : [...picks, option.value],
                    )
                  }
                />
                <Label htmlFor={`${field.key}-${option.value}`} className='cursor-pointer text-sm font-normal'>
                  {option.label}
                  {option.description ? (
                    <span className='ml-1 text-xs text-muted-foreground'>{option.description}</span>
                  ) : null}
                </Label>
              </div>
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
        <Button size='sm' asChild>
          <a href={url} target='_blank' rel='noreferrer noopener'>
            <ExternalLink className='size-3.5' />
            Open
          </a>
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
