'use client'

import { CircleAlert, Copy } from 'lucide-react'

import { Alert, AlertAction, AlertDescription, AlertTitle } from 'ui/components/ui/alert'
import { Button } from 'ui/components/ui/button'

/** One error of a node, as whoever reported it described it. */
export interface NodeErrorItem {
  /** What failed, in a few words: "Can't reach the Docker daemon". */
  title: string
  /** The output that explains it, such as the relevant lines of a command's stderr. Kept as written. */
  detail?: string
  /** A short secondary identifier of the failure: an exit code, an HTTP status. */
  code?: string
  /** What to do about it, where that is known. */
  next?: string
}

export interface NodeErrorsProps {
  errors: NodeErrorItem[]
  /**
   * Notified after an error has been copied, so the host can confirm it however
   * it confirms things. The copy itself happens here, so this never gates the
   * button.
   */
  onCopy?: (text: string) => void
}

/** The error as one block of text, for pasting into a chat or a ticket. */
export function nodeErrorText({ title, detail, code, next }: NodeErrorItem): string {
  return [title, detail, code, next].filter(Boolean).join('\n\n')
}

// A node's errors, one alert each, in the order they were reported. The host
// shows this tab only while there are errors, so an empty list is an empty
// column rather than an empty state.
export function NodeErrors({ errors, onCopy }: NodeErrorsProps) {
  const copy = (error: NodeErrorItem) => {
    const text = nodeErrorText(error)
    navigator.clipboard?.writeText(text)
    onCopy?.(text)
  }

  return (
    <div className='flex flex-col gap-2'>
      {errors.map((error, index) => (
        <Alert key={`${index}:${error.title}`} variant='destructive'>
          <CircleAlert />
          <AlertTitle className='wrap-anywhere'>{error.title}</AlertTitle>
          <AlertDescription className='flex flex-col gap-2'>
            {error.detail ? (
              <pre className='max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-foreground'>
                {error.detail}
              </pre>
            ) : null}
            {error.code ? <span className='text-xs text-muted-foreground'>{error.code}</span> : null}
            {error.next ? <p className='text-foreground'>{error.next}</p> : null}
          </AlertDescription>
          <AlertAction>
            <Button variant='ghost' size='icon-xs' title='Copy error' aria-label='Copy error' onClick={() => copy(error)}>
              <Copy />
            </Button>
          </AlertAction>
        </Alert>
      ))}
    </div>
  )
}
