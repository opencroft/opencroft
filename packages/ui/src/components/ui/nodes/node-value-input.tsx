import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { Input } from '../input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import { Switch } from '../switch'
import { Textarea } from '../textarea'

/** What a value input takes: text, a number, or true / false. */
export type NodeValueKind = 'text' | 'number' | 'boolean'

export type NodeValue = string | number | boolean

/** One choice of a text input that takes only these. */
export interface NodeValueOption {
  value: string
  label?: string
}

export interface NodeValueInputProps {
  kind: NodeValueKind
  /** The input's name, for assistive technology: the field sits beside its label and repeats none. */
  label: string
  /**
   * The value shown: the one typed, else the input's default; nothing shows an
   * empty field. While `wired`, the value the edge brings.
   */
  value?: NodeValue
  /**
   * Told a committed value: for text and a number on Enter or when the field
   * loses focus, for a toggle or a choice as it changes. A number is committed
   * already rounded (`integer`) and kept within `min` and `max`; text that is
   * not a number puts the field back as it was.
   */
  onCommit?: (value: NodeValue) => void
  /** An edge feeds the input: `value` is shown read-only and greyed, and nothing is committed. */
  wired?: boolean
  /** A number input takes whole numbers. */
  integer?: boolean
  min?: number
  max?: number
  /** How far the arrow keys move a number: 1 unless given. */
  step?: number
  /** A text input that takes only these: a dropdown. */
  options?: NodeValueOption[]
  /** A text input that takes several lines: a text area growing to four. Enter starts a line, Ctrl or Cmd+Enter commits. */
  multiline?: boolean
  /** A text input that takes code, such as a regular expression: typed in the monospace font. */
  monospace?: boolean
  placeholder?: string
}

// Flat, as the field of a Prompt node: no border and no shadow, only the
// theme's field fill. A value on a card reads as text typed in place, not as
// a form control. A toggle or a dropdown keeps its focus ring,
// which shows for keyboard focus only (`:focus-visible`); a text field drops
// it, since a text field matches `:focus-visible` on a press too and its caret
// already shows where the focus is.
const FLAT = 'border-0 bg-field shadow-none'
const FLAT_TEXT = `${FLAT} focus-visible:ring-0`

// Compact on a card; at least 44 px tall where the pointer is a finger.
const FIELD = `${FLAT_TEXT} h-7 px-2 text-xs md:text-xs pointer-coarse:h-11`

/** `text` read as a number for the input, or null when it is none. */
function readNumber(text: string, { integer, min, max }: Pick<NodeValueInputProps, 'integer' | 'min' | 'max'>) {
  if (text.trim() === '') {
    return null
  }
  let n = Number(text)
  if (!Number.isFinite(n)) {
    return null
  }
  if (integer) {
    n = Math.round(n)
  }
  if (min !== undefined) {
    n = Math.max(min, n)
  }
  if (max !== undefined) {
    n = Math.min(max, n)
  }
  return n
}

function shown(value: NodeValue | undefined): string {
  return value === undefined ? '' : String(value)
}

// A text or number field edits a draft of its own, so the value is written
// once, when committed, and an update arriving from elsewhere while it is
// being typed in does not move the caret: the field takes the outside value
// whenever it is not focused.
function TypedField(props: NodeValueInputProps) {
  const { kind, label, value, onCommit, wired, integer, min, max, step = 1, multiline, monospace, placeholder } = props
  const [draft, setDraft] = useState(shown(value))
  const [editing, setEditing] = useState(false)
  // Set by Escape for the blur it causes: that blur runs inside the same key
  // press, before the reverted draft renders, so it would commit the typed text.
  const cancelling = useRef(false)

  useEffect(() => {
    if (!editing) {
      setDraft(shown(value))
    }
  }, [value, editing])

  const commit = (text: string) => {
    if (kind === 'text') {
      if (text !== shown(value)) {
        onCommit?.(text)
      }
      return
    }
    const n = readNumber(text, { integer, min, max })
    if (n === null) {
      setDraft(shown(value))
      return
    }
    setDraft(String(n))
    if (n !== value) {
      onCommit?.(n)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      cancelling.current = true
      setDraft(shown(value))
      e.currentTarget.blur()
      cancelling.current = false
      return
    }
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.currentTarget.blur()
      return
    }
    if (kind === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const from = readNumber(draft, {}) ?? (typeof value === 'number' ? value : 0)
      const next = readNumber(String(from + (e.key === 'ArrowUp' ? step : -step)), { integer, min, max })
      if (next !== null) {
        setDraft(String(next))
      }
    }
  }

  const field = {
    'aria-label': label,
    value: draft,
    disabled: wired,
    placeholder,
    onFocus: () => setEditing(true),
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      setEditing(false)
      if (!wired && !cancelling.current) {
        commit(draft)
      }
    },
    onKeyDown: handleKeyDown,
  }

  const font = kind === 'number' ? 'tabular-nums' : monospace ? 'font-mono' : ''
  if (kind === 'text' && multiline) {
    return (
      <Textarea
        {...field}
        rows={1}
        className={`${FLAT_TEXT} ${font} max-h-[calc(4lh+1rem)] min-h-7 resize-none px-2 py-1 text-xs md:text-xs pointer-coarse:min-h-11`}
      />
    )
  }
  // A number is typed as text: no spinner, and no wheel or drag that changes
  // it by accident on a canvas that pans and zooms.
  return (
    <Input
      {...field}
      type='text'
      inputMode={kind === 'number' ? (integer && (min ?? -1) >= 0 ? 'numeric' : 'decimal') : undefined}
      className={`${FIELD} ${font}`}
    />
  )
}

/**
 * The field on a node's card for an input that takes a plain value: a text
 * field, a number field, a switch for true / false, or a dropdown for a text
 * input with `options`.
 */
export function NodeValueInput(props: NodeValueInputProps) {
  const { kind, label, value, onCommit, wired, options } = props

  if (kind === 'boolean') {
    return (
      <div className='flex h-7 items-center pointer-coarse:h-11'>
        <Switch
          aria-label={label}
          checked={value === true}
          disabled={wired}
          onCheckedChange={(checked) => onCommit?.(checked)}
          className='shadow-none pointer-coarse:after:-inset-y-3.5'
        />
      </div>
    )
  }

  if (kind === 'text' && options && options.length > 0) {
    // The trigger shows the chosen option's label, or the value itself when it is none of them.
    const labelOf = (chosen: unknown) => {
      const option = options.find((o) => o.value === chosen)
      return option ? (option.label ?? option.value) : shown(value)
    }
    return (
      <Select
        value={typeof value === 'string' ? value : null}
        disabled={wired}
        onValueChange={(next) => {
          if (typeof next === 'string') {
            onCommit?.(next)
          }
        }}
      >
        <SelectTrigger size='sm' aria-label={label} className={`${FLAT} h-7 w-full px-2 text-xs dark:hover:bg-input/30 pointer-coarse:h-11`}>
          <SelectValue className='truncate'>{labelOf}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} className='text-xs pointer-coarse:min-h-11'>
              {option.label ?? option.value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return <TypedField {...props} />
}
