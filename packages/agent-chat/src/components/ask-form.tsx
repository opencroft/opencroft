'use client'

import type { ElicitationContentValue, ElicitationSchema } from 'agent-client/types'
import { ExternalLink, MessageCircleQuestion, X } from 'lucide-react'
import { useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Checkbox } from 'ui/components/ui/checkbox'
import { Input } from 'ui/components/ui/input'
import { Label } from 'ui/components/ui/label'
import { RadioGroup, RadioGroupItem } from 'ui/components/ui/radio-group'

/**
 * One rendered form field, derived from an ACP elicitation schema property.
 *
 * The ACP property union is folded into the five shapes a form can actually
 * draw. Options carry value and label apart because the wire answer is the
 * `const`/enum VALUE while the reader picks by title — collapsing them is how
 * an answer ends up carrying a label the agent's schema rejects.
 */
export interface AskFormField {
  key: string
  title: string
  description?: string
  required: boolean
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

/**
 * Fold an elicitation schema into renderable fields.
 *
 * Unknown property types degrade to a text input rather than vanishing: a
 * field the reader cannot see is an answer the agent never gets, and free text
 * at least reaches it as a string the schema may still accept.
 */
export function formFields(schema: ElicitationSchema): AskFormField[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([key, property]) => {
    const record = property as PropertyRecord
    const title = typeof record.title === 'string' && record.title ? record.title : key
    const description = typeof record.description === 'string' && record.description ? record.description : undefined
    const base = { key, title, ...(description ? { description } : {}), required: required.has(key) }
    if (record.type === 'string') {
      const options = enumOptions(record.oneOf) ?? enumOptions(record.enum)
      return { ...base, kind: options ? { type: 'select' as const, options } : { type: 'text' as const } }
    }
    if (record.type === 'array') {
      const items = (record.items ?? {}) as PropertyRecord
      const options = enumOptions(items.anyOf) ?? enumOptions(items.enum) ?? []
      return { ...base, kind: { type: 'multi' as const, options } }
    }
    if (record.type === 'boolean') {
      return { ...base, kind: { type: 'boolean' as const } }
    }
    if (record.type === 'number' || record.type === 'integer') {
      return { ...base, kind: { type: 'number' as const, integer: record.type === 'integer' } }
    }
    return { ...base, kind: { type: 'text' as const } }
  })
}

/**
 * Build the accept-content for the current inputs, or null while a required
 * field is still unanswered. One function for both the submit gate and the
 * submit payload, so the button can never enable on inputs the payload
 * builder would then drop.
 */
export function buildFormContent(
  fields: AskFormField[],
  values: Record<string, string | string[] | boolean>,
): Record<string, ElicitationContentValue> | null {
  const content: Record<string, ElicitationContentValue> = {}
  for (const field of fields) {
    const value = values[field.key]
    switch (field.kind.type) {
      case 'multi': {
        const picks = Array.isArray(value) ? value : []
        if (picks.length > 0) {
          content[field.key] = picks
        } else if (field.required) {
          return null
        }
        break
      }
      case 'boolean': {
        // A checkbox is always answered — unchecked is `false`, not absence.
        content[field.key] = value === true
        break
      }
      case 'number': {
        const text = typeof value === 'string' ? value.trim() : ''
        if (text === '') {
          if (field.required) {
            return null
          }
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
        } else if (field.required) {
          return null
        }
        break
      }
    }
  }
  return content
}

export interface AskFormProps {
  message: string
  schema: ElicitationSchema
  onSubmit: (content: Record<string, ElicitationContentValue>) => void
  onCancel: () => void
}

/** An ACP form elicitation: the agent's questions, rendered from the schema it
 * sent, answered as one content object keyed by that schema's properties. */
export function AskForm({ message, schema, onSubmit, onCancel }: AskFormProps) {
  const [values, setValues] = useState<Record<string, string | string[] | boolean>>({})
  const fields = formFields(schema)
  const content = buildFormContent(fields, values)
  const setValue = (key: string, value: string | string[] | boolean) =>
    setValues((prev) => ({ ...prev, [key]: value }))

  return (
    <div className='flex flex-col gap-2 rounded-md border p-3 text-sm'>
      <div className='flex items-start gap-2'>
        <MessageCircleQuestion className='mt-0.5 size-4 shrink-0 text-primary' />
        <span className='min-w-0 flex-1 whitespace-pre-wrap wrap-break-word'>{message}</span>
        <Button size='sm' variant='ghost' onClick={onCancel} className='size-6 shrink-0 p-0' aria-label='Dismiss'>
          <X className='size-4' />
        </Button>
      </div>
      {fields.map((field) => (
        <div key={field.key} className='flex flex-col gap-1.5'>
          <div>
            <span className='font-medium'>{field.title}</span>
            {field.description ? <div className='text-xs text-muted-foreground'>{field.description}</div> : null}
          </div>
          {field.kind.type === 'select' ? (
            <RadioGroup
              value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
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
                const picks = Array.isArray(values[field.key]) ? (values[field.key] as string[]) : []
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
                checked={values[field.key] === true}
                onCheckedChange={(checked) => setValue(field.key, checked === true)}
              />
              <Label htmlFor={field.key} className='cursor-pointer text-sm font-normal'>
                {field.title}
              </Label>
            </div>
          ) : (
            <Input
              value={typeof values[field.key] === 'string' ? (values[field.key] as string) : ''}
              onChange={(event) => setValue(field.key, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && content) {
                  event.preventDefault()
                  onSubmit(content)
                }
              }}
              inputMode={field.kind.type === 'number' ? 'decimal' : undefined}
              placeholder={field.required ? 'Required' : 'Optional'}
              className='h-8'
            />
          )}
        </div>
      ))}
      <Button size='sm' disabled={!content} onClick={() => content && onSubmit(content)} className='w-full'>
        Submit
      </Button>
    </div>
  )
}

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
