'use client'

import { Alert, AlertAction, AlertDescription } from 'ui/alert'
import { Button } from 'ui/button'

// Why this chat has no session and has stopped trying to open one, and the way
// to ask again once the reader has done something about it (set the key, signed
// in, closed the session holding the connection). Renders nothing while the
// chat is connected or still retrying on its own -- see AcpSession.openError.
export function SessionOpenNotice({ message, onRetry }: { message?: string; onRetry: () => void }) {
  if (!message) {
    return null
  }
  return (
    <Alert variant='destructive'>
      <AlertDescription className='wrap-break-word'>{message}</AlertDescription>
      <AlertAction>
        <Button size='xs' variant='outline' onClick={onRetry}>
          Try again
        </Button>
      </AlertAction>
    </Alert>
  )
}
