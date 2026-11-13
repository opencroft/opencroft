import { GripVertical, Plus, X } from 'lucide-react'
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '../button'
import { InputGroup } from '../input-group'
import { useRowDrag } from '../utils/row-drag'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table'
import { cn } from 'cn'

import { type NodeRowSlot, reorderedIds } from './node-row-list'
import { CommitField, isSecretValue, SecretValueInput, type SecretValue } from './secret-value-field'

/** Where a variable's value comes from: typed, or a stored secret named here. */
export type EnvironmentValue = SecretValue

export type EnvironmentVariable = { name: string } & EnvironmentValue

export interface EnvironmentTableProps {
  /** In order, each name once: a row is known by its name. */
  variables: EnvironmentVariable[]
  /** The names of the secrets a value can be taken from. Only names cross
   * this component, never a secret's value. Left out, every value is typed:
   * the rows have no key button. */
  secrets?: string[]
  /** The whole list, after any change: a row named, removed, renamed or
   * moved, or its value typed or pointed at a secret. A row not named yet is
   * not in it. */
  onChange: (variables: EnvironmentVariable[]) => void
  /** The host's rule for a name, as the sentence to show, or undefined when
   * the name is fine. Empty and duplicate names are refused here already. */
  validateName?: (name: string) => string | undefined
  /** The host's warning about a typed value, as the sentence to show, or
   * undefined when there is none. The row is marked and the sentence shown
   * under the table. A value taken from a secret is never asked about. */
  valueWarning?: (variable: { name: string; value: string }) => string | undefined
  /** Shown in the secret list when there is nothing to pick. */
  noSecretsMessage?: string
  /** What one row is, in the name column's heading and in the labels and
   * sentences about a row. Read after "a": "A header needs a name." */
  nameLabel?: string
  /** The name field's placeholder, shown while a row has no name. */
  namePlaceholder?: string
  disabled?: boolean
  className?: string
}

// A row as drawn: a variable of the list, or one added and not named yet.
interface Row {
  key: number
  variable: EnvironmentVariable
  /** Its place in `variables`; -1 for a row not named yet, which is not in it. */
  index: number
}

// A row added and not named yet: where it is drawn, and the value it holds.
interface Unnamed {
  key: number
  at: number
  value: SecretValue
}

// The keys a row's handle takes, as `aria-keyshortcuts` names them.
const HANDLE_KEYS = 'ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown'
// Every cell: a line between columns, and no padding, so a field fills its
// cell and its focus ring is the cell's.
const CELL = 'border-l p-0 first:border-l-0'
const DROP_BEFORE = '[&>td]:border-t-2 [&>td]:border-t-primary'
const DROP_AFTER = '[&>td]:border-b-2 [&>td]:border-b-primary'

const valueOf = (variable: EnvironmentVariable): SecretValue =>
  isSecretValue(variable) ? { secret: variable.secret } : { value: variable.value }

const sameValue = (a: SecretValue, b: SecretValue): boolean =>
  isSecretValue(a) ? isSecretValue(b) && a.secret === b.secret : !isSecretValue(b) && a.value === b.value

const sameList = (a: EnvironmentVariable[], b: EnvironmentVariable[]): boolean =>
  a.length === b.length && a.every((variable, i) => variable.name === b[i].name && sameValue(variable, b[i]))

// A node's environment variables, or any list of names and values, as a
// table: a handle, Variable, Value, and a column of X buttons, under a header
// row whose last cell is the plus that adds a row.
//
// ADD, THEN FILL IN. The plus appends an empty row and puts the focus in its
// name. That row is edited in place like every other, and there is no draft
// line: what is typed into a row is the row. A row with no name yet cannot be
// stored (a variable is known by its name), so it stays on screen, here only,
// until it is named, and then joins `variables` at its place with whatever
// value it already holds. One that already holds a value says so under the
// table, so a value is never left behind unnoticed.
//
// Fields commit on Enter or leaving them, never per keystroke. A name typed one
// letter at a time passes through other names on its way, and one of them can
// be a name another row already holds; committing on the way would let a
// half-typed rename land on that row.
//
// MOVING A ROW. Its handle drags it: the kit's row drag, native drag and drop
// under a mouse, a still hold under a finger, as a node's own rows move. From
// the keyboard, the up and down arrows on a focused handle (with or without
// Alt, as on a node's rows) move the row a place. The new order goes out
// through `onChange` like any other change.
//
// A secret the host does not offer any more stays in its row and is marked as
// not found, rather than dropped: the row is still what the node asks for, and
// the break shows here before it shows at the next start.
//
// The same table holds any list of names and values, request headers and
// container labels among them: `nameLabel` says what a row is, and a list
// whose values are never secrets leaves `secrets` out. A typed value the
// host warns about (a credential typed where a secret belongs) is marked in its
// row and the host's sentence is shown under the table, where a touch screen
// shows it too.
export function EnvironmentTable({
  variables,
  secrets,
  onChange,
  validateName,
  valueWarning,
  noSecretsMessage,
  nameLabel = 'Variable',
  namePlaceholder = 'NAME',
  disabled = false,
  className,
}: EnvironmentTableProps) {
  const tableId = useId()
  const [unnamed, setUnnamed] = useState<Unnamed[]>([])
  const [error, setError] = useState<string>()
  const noun = nameLabel.toLowerCase()

  // A row's key follows its name, so a row keeps its elements while rows above
  // it come and go. A rename made here, and the naming of a new row, carries
  // the row's key over to the name: the rename is committed by the press that
  // left the field, and the row has to be the same row when that press is
  // released.
  const keys = useRef(new Map<string, number>())
  const lastKey = useRef(0)
  const newKey = (): number => {
    lastKey.current += 1
    return lastKey.current
  }
  const keyOf = (name: string): number => {
    let key = keys.current.get(name)
    if (key === undefined) {
      key = newKey()
      keys.current.set(name, key)
    }
    return key
  }

  const rows: Row[] = variables.map((variable, index) => ({ key: keyOf(variable.name), variable, index }))
  for (const row of [...unnamed].sort((a, b) => a.at - b.at)) {
    rows.splice(Math.min(row.at, rows.length), 0, { key: row.key, variable: { name: '', ...row.value }, index: -1 })
  }
  // For a touch drop, which lands from the press's own listeners.
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // A new row, whose name field takes the focus once it is drawn.
  const focusKey = useRef<number | undefined>(undefined)

  // Asked of a typed value of a named row only.
  const warningFor = (variable: EnvironmentVariable): string | undefined =>
    valueWarning && !isSecretValue(variable) && variable.name.trim()
      ? valueWarning({ name: variable.name.trim(), value: variable.value })
      : undefined
  const holdsValue = (value: SecretValue): boolean => isSecretValue(value) || value.value !== ''
  // One line per sentence: two rows the host words the same way say it once.
  const warnings = [
    ...new Set(
      [
        ...variables.map(warningFor),
        unnamed.some((row) => holdsValue(row.value)) ? `A ${noun} without a name is not saved.` : undefined,
      ].filter((warning): warning is string => Boolean(warning)),
    ),
  ]

  // `index` is the row being named, so a row keeping its own name is not a
  // duplicate of itself; a row not named yet passes -1.
  const nameProblem = (name: string, index: number): string | undefined => {
    if (!name) {
      return `A ${noun} needs a name.`
    }
    if (variables.some((variable, i) => i !== index && variable.name === name)) {
      return `There is already a ${noun} named ${name}.`
    }
    return validateName?.(name)
  }

  // The rows as they are to be drawn after a change: the named ones go to the
  // host when they differ from `variables`, the others stay here, where drawn.
  const commit = (next: Row[]) => {
    setError(undefined)
    setUnnamed(next.flatMap((row, at) => (row.variable.name ? [] : [{ key: row.key, at, value: valueOf(row.variable) }])))
    const named = next.filter((row) => row.variable.name).map((row) => row.variable)
    if (!sameList(named, variables)) {
      onChange(named)
    }
  }

  const withRow = (key: number, variable: EnvironmentVariable): Row[] =>
    rows.map((row) => (row.key === key ? { ...row, variable } : row))

  const rename = (row: Row, text: string) => {
    const name = text.trim()
    const previous = row.variable.name
    if (name === previous) {
      return
    }
    // A refused name is reported and the field shows the stored one again.
    const problem = nameProblem(name, row.index)
    if (problem) {
      setError(problem)
      return
    }
    keys.current.set(name, row.key)
    if (previous) {
      keys.current.delete(previous)
    }
    commit(withRow(row.key, { ...row.variable, name }))
  }

  const add = () => {
    const key = newKey()
    focusKey.current = key
    setError(undefined)
    setUnnamed([...unnamed, { key, at: rows.length, value: { value: '' } }])
  }

  // `dragged` dropped at `slot`; a drop where it already is changes nothing.
  const move = (dragged: number, slot: NodeRowSlot) => {
    const current = rowsRef.current
    const order = reorderedIds(
      current.map((row) => String(row.key)),
      String(dragged),
      slot,
    )
    if (order) {
      commit(order.flatMap((id) => current.filter((row) => String(row.key) === id)))
    }
  }

  const { drag, over, lifted, ghost, rootRef, rootProps, sourceProps } = useRowDrag<number, NodeRowSlot>({
    targetAt: (_dragged, element, point) => {
      const line = element?.closest<HTMLElement>('[data-env-row]')
      if (!line || line.dataset.envTable !== tableId) {
        return null
      }
      const box = line.getBoundingClientRect()
      return { index: Number(line.dataset.envRow), pos: point.y < box.top + box.height / 2 ? 'before' : 'after' }
    },
    onDrop: move,
  })

  useLayoutEffect(() => {
    const key = focusKey.current
    if (key === undefined) {
      return
    }
    focusKey.current = undefined
    rootRef.current?.querySelector<HTMLInputElement>(`[data-env-name="${key}"]`)?.focus()
  })

  const onHandleKeyDown = (row: Row, at: number) => (event: KeyboardEvent<HTMLElement>) => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || event.ctrlKey || event.metaKey || event.shiftKey) {
      return
    }
    // Stopped here either way, so an arrow on a handle never scrolls the page
    // or reaches a canvas behind it.
    event.preventDefault()
    event.stopPropagation()
    const to = at + (event.key === 'ArrowUp' ? -1 : 1)
    if (!disabled && to >= 0 && to < rows.length) {
      move(row.key, { index: to, pos: to < at ? 'before' : 'after' })
    }
  }

  const rowName = (row: Row) => row.variable.name || `the new ${noun}`
  const ghostRow = ghost ? rows.find((row) => row.key === ghost.drag) : undefined

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <div ref={rootRef} className='relative min-w-0 overflow-hidden rounded-md border' {...rootProps}>
        <Table className='table-fixed'>
          <TableHeader>
            <TableRow className='bg-muted/50 hover:bg-muted/50'>
              <TableHead className={cn(CELL, 'h-8 w-8')}>
                <span className='sr-only'>Order</span>
              </TableHead>
              <TableHead className={cn(CELL, 'h-8 w-2/5 px-2 text-xs')}>{nameLabel}</TableHead>
              <TableHead className={cn(CELL, 'h-8 px-2 text-xs')}>Value</TableHead>
              <TableHead className={cn(CELL, 'h-8 w-8 text-center')}>
                <Button variant='ghost' size='icon-xs' aria-label={`Add ${noun}`} disabled={disabled} onClick={add}>
                  <Plus />
                </Button>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className='hover:bg-transparent'>
                <TableCell colSpan={4} className='h-8 px-2 text-xs text-muted-foreground'>
                  No {noun}s.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, at) => (
                <TableRow
                  key={row.key}
                  data-env-row={at}
                  data-env-table={tableId}
                  className={cn(
                    'hover:bg-transparent',
                    drag === row.key && 'opacity-40',
                    lifted === row.key && 'bg-muted',
                    over?.index === at && (over.pos === 'before' ? DROP_BEFORE : DROP_AFTER),
                  )}
                >
                  <TableCell className={CELL}>
                    <div
                      {...sourceProps(row.key, { enabled: !disabled, text: row.variable.name })}
                      role='button'
                      tabIndex={disabled ? -1 : 0}
                      aria-label={`Move ${rowName(row)}`}
                      aria-keyshortcuts={HANDLE_KEYS}
                      aria-disabled={disabled || undefined}
                      onKeyDown={onHandleKeyDown(row, at)}
                      style={{ WebkitTouchCallout: 'none', userSelect: 'none' }}
                      className='flex h-8 cursor-grab items-center justify-center text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset aria-disabled:cursor-default aria-disabled:opacity-50'
                    >
                      <GripVertical className='size-3.5' />
                    </div>
                  </TableCell>
                  <TableCell className={CELL}>
                    <InputGroup variant='flat' data-disabled={disabled || undefined}>
                      <CommitField
                        data-env-name={row.key}
                        className='font-mono text-xs'
                        aria-label={nameLabel}
                        placeholder={namePlaceholder}
                        value={row.variable.name}
                        disabled={disabled}
                        onCommit={(text) => rename(row, text)}
                      />
                    </InputGroup>
                  </TableCell>
                  <TableCell className={CELL}>
                    <SecretValueInput
                      variant='flat'
                      value={row.variable}
                      secrets={secrets}
                      noSecretsMessage={noSecretsMessage}
                      warning={warningFor(row.variable)}
                      disabled={disabled}
                      onCommit={(value) => commit(withRow(row.key, { name: row.variable.name, ...value }))}
                    />
                  </TableCell>
                  <TableCell className={cn(CELL, 'text-center')}>
                    <Button
                      variant='ghost'
                      size='icon-xs'
                      aria-label={`Remove ${rowName(row)}`}
                      disabled={disabled}
                      onClick={() => commit(rows.filter((other) => other.key !== row.key))}
                    >
                      <X />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {ghost && ghostRow ? (
          <div
            className='pointer-events-none absolute z-50 opacity-60'
            style={{ left: ghost.x, top: ghost.y, transform: 'translateY(-50%)' }}
          >
            <div className='rounded-md bg-background px-2 py-1 font-mono text-xs shadow-lg ring-1 ring-border'>
              {ghostRow.variable.name || namePlaceholder}
            </div>
          </div>
        ) : null}
      </div>
      {warnings.map((warning) => (
        <p key={warning} className='px-1 text-xs text-warning'>
          {warning}
        </p>
      ))}
      {error ? (
        <p role='alert' className='px-1 text-xs text-destructive'>
          {error}
        </p>
      ) : null}
    </div>
  )
}
