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
  SecretInput,
  secretFieldAttributes,
} from '@opencroft/client/ui'
import { type FormEvent, useId, useState } from 'react'

export interface SetPasswordTarget {
  key: string
  /** The store already holds the name, so the dialog replaces its value. */
  exists: boolean
  /** The login the dialog starts with; empty for none yet. */
  login: string
  /** Where the Basic box starts. */
  basic: boolean
}

export interface LoginPassword {
  login: string
  password: string
  /** Store it as `Basic base64(login:password)` rather than `login:password`. */
  basic: boolean
}

// The dialog's fields, mounted per open so the password starts empty.
function SetPasswordForm({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: SetPasswordTarget
  busy: boolean
  onCancel: () => void
  onSubmit: (entered: LoginPassword) => void
}) {
  const id = useId()
  const [login, setLogin] = useState(target.login)
  const [password, setPassword] = useState('')
  const [basic, setBasic] = useState(target.basic)
  const [problem, setProblem] = useState<string>()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    // RFC 7617 and `curl -u` alike end the login at the first colon.
    if (!login || login.includes(':')) {
      setProblem(login ? 'The login cannot contain ":".' : 'Type the login.')
      return
    }
    if (!password) {
      setProblem('Type or paste the password.')
      return
    }
    onSubmit({ login, password, basic })
  }

  return (
    // A credential-bearing form posts, so a submit before hydration never puts a field in the URL.
    <form method='post' onSubmit={submit} className='flex flex-col gap-3'>
      <DialogHeader>
        <DialogTitle>
          Set password for <span className='font-mono break-all'>{target.key}</span>
        </DialogTitle>
        <DialogDescription>
          {target.exists
            ? 'Replaces the current value; whatever uses it gets the new one at its next run, and Applications need a redeploy. '
            : null}
          Only the login is kept beside the value, and Rotate is not offered for it.
        </DialogDescription>
      </DialogHeader>
      <div className='flex flex-col gap-1'>
        <Label htmlFor={`${id}-login`} className='text-xs'>
          Login
        </Label>
        {/* The opt-outs keep password managers from reading login and password as a sign-in form. */}
        <Input
          id={`${id}-login`}
          {...secretFieldAttributes}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          className='h-8 font-mono text-xs'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label htmlFor={`${id}-password`} className='text-xs'>
          Password
        </Label>
        <SecretInput
          id={`${id}-password`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className='h-8'
        />
      </div>
      <Label className='flex items-start gap-2 text-xs font-normal'>
        <Checkbox
          checked={basic}
          onCheckedChange={(checked) => setBasic(checked === true)}
          aria-describedby={`${id}-stores`}
        />
        <span className='flex flex-col gap-0.5'>
          <span>Basic auth header</span>
          <span id={`${id}-stores`} className='text-muted-foreground'>
            Stores{' '}
            <span className='font-mono break-all'>{basic ? 'Basic base64(login:password)' : 'login:password'}</span>
            {basic ? ', for an Authorization header.' : ' as it is, the form curl -u takes.'}
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
          {target.exists ? 'Replace' : 'Create'}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** The dialog behind Set password… in a secret's menu, for a new secret and a stored one alike. */
export function SetPasswordDialog({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: SetPasswordTarget | null
  busy: boolean
  onCancel: () => void
  onSubmit: (entered: LoginPassword) => void
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
          <SetPasswordForm key={target.key} target={target} busy={busy} onCancel={onCancel} onSubmit={onSubmit} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
