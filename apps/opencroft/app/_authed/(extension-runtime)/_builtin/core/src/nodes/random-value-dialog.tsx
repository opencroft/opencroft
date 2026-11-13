import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@opencroft/client/ui'
import type { RandomSecretSpec, SecretFormat } from '@opencroft/server/secrets'
import { RefreshCw } from 'lucide-react'
import { type FormEvent, type ReactNode, useId, useState } from 'react'

import { describeReference, type NodeReference } from './delete-refusal-shared'
import { FORMAT_LABELS, MAX_LENGTH, MIN_LENGTH, type RandomValueMode } from './secret-recipe-shared'

export interface RandomValueTarget {
  key: string
  mode: RandomValueMode
  /** What uses the stored secret and stops working with the old value; empty for a new one. */
  references: NodeReference[]
  /** What the fields start with (see `startingRandom`). */
  spec: RandomSecretSpec
  bearer: boolean
}

export interface RandomValueChoice extends RandomSecretSpec {
  /** The value goes under the `Bearer ` prefix. */
  bearer: boolean
}

const SUBMIT_LABELS: Record<RandomValueMode, ReactNode> = {
  create: 'Create',
  rotate: (
    <>
      <RefreshCw /> Rotate
    </>
  ),
  replace: 'Replace',
}

function rotateWarning(references: NodeReference[]): string {
  return references.length > 0
    ? ' These nodes on this graph and apps of this space use it and pick up the new value at their next run; Applications need a redeploy.'
    : ' No node on this graph names it as a secrets line, an apiKeySecret or a secret: value, and no app of this space as a secret: value. That is all this checks: anything that uses it another way, such as a tool’s auth, also stops working.'
}

// The dialog's fields, mounted per open so they start from the target.
function RandomValueForm({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: RandomValueTarget
  busy: boolean
  onCancel: () => void
  onSubmit: (choice: RandomValueChoice) => void
}) {
  const id = useId()
  const [length, setLength] = useState(String(target.spec.length))
  const [format, setFormat] = useState<SecretFormat>(target.spec.format)
  const [bearer, setBearer] = useState(target.bearer)
  const [problem, setProblem] = useState<string>()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = Number(length)
    if (!Number.isInteger(parsed) || parsed < MIN_LENGTH || parsed > MAX_LENGTH) {
      setProblem(`The length is a whole number from ${MIN_LENGTH} to ${MAX_LENGTH}.`)
      return
    }
    onSubmit({ length: parsed, format, bearer })
  }

  return (
    <form onSubmit={submit} className='flex flex-col gap-3'>
      <DialogHeader>
        <DialogTitle>
          {target.mode === 'rotate' ? 'Rotate ' : 'Random value for '}
          <span className='font-mono break-all'>{target.key}</span>
        </DialogTitle>
        <DialogDescription>
          {target.mode === 'create'
            ? 'The value is made on the server and saved at once; the eye in the field shows it.'
            : `The current value is replaced with a new random one, made on the server, and the old value stops working.${rotateWarning(target.references)}`}
        </DialogDescription>
      </DialogHeader>
      {target.references.length > 0 ? (
        <ul className='flex flex-col gap-1 text-xs'>
          {target.references.map((ref) => (
            <li key={ref.nodeId}>{describeReference(ref)}</li>
          ))}
        </ul>
      ) : null}
      <div className='flex gap-2'>
        <div className='flex flex-col gap-1 w-20 shrink-0'>
          <Label htmlFor={`${id}-length`} className='text-xs'>
            Length
          </Label>
          <Input
            id={`${id}-length`}
            type='number'
            min={MIN_LENGTH}
            max={MAX_LENGTH}
            value={length}
            onChange={(e) => setLength(e.target.value)}
            className='h-8 text-xs'
          />
        </div>
        <div className='flex flex-col gap-1 flex-1 min-w-0'>
          <Label id={`${id}-format`} className='text-xs'>
            Format
          </Label>
          <Select
            value={format}
            items={FORMAT_LABELS}
            onValueChange={(v) => {
              if (v !== null) {
                setFormat(v)
              }
            }}
          >
            <SelectTrigger size='sm' className='text-xs w-full' aria-labelledby={`${id}-format`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(FORMAT_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Label className='flex items-start gap-2 text-xs font-normal'>
        <Checkbox
          checked={bearer}
          onCheckedChange={(checked) => setBearer(checked === true)}
          aria-describedby={`${id}-stores`}
        />
        <span className='flex flex-col gap-0.5'>
          <span>Bearer token</span>
          <span id={`${id}-stores`} className='text-muted-foreground'>
            Stores <span className='font-mono'>{bearer ? 'Bearer <value>' : '<value>'}</span>
            {bearer ? ', for an Authorization header.' : ' as it is.'}
          </span>
        </span>
      </Label>
      {problem ? (
        <p className='text-xs text-destructive' role='alert'>
          {problem}
        </p>
      ) : null}
      <DialogFooter>
        <Button type='button' variant='outline' onClick={onCancel}>
          Cancel
        </Button>
        <Button type='submit' disabled={busy}>
          {SUBMIT_LABELS[target.mode]}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The dialog behind Random value… and Rotate…, on new and stored secrets alike: the same fields,
 *  started from the secret's recipe. */
export function RandomValueDialog({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: RandomValueTarget | null
  busy: boolean
  onCancel: () => void
  onSubmit: (choice: RandomValueChoice) => void
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <DialogContent>
        {target ? (
          <RandomValueForm key={target.key} target={target} busy={busy} onCancel={onCancel} onSubmit={onSubmit} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
