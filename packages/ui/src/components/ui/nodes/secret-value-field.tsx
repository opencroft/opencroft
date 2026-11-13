import { CircleAlert, KeyRound } from 'lucide-react'
import { type ComponentProps, useId, useRef, useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '../input-group'
import { Label } from '../label'
import { cn } from 'cn'

/** Where a value comes from: typed, or a stored secret named here. */
export type SecretValue = { value: string } | { secret: string }

export function isSecretValue(value: SecretValue): value is { secret: string } {
  return 'secret' in value
}

const NO_SECRETS = 'No secrets to choose from.'

// What keeps a field that holds a secret value away from password managers,
// the browser's own and the extensions. A password-type field reads to them as
// a login: they offer saved passwords in it and offer to save what is typed,
// and Chrome ignores `autocomplete="off"` there. So the field is a text field,
// drawn as dots by `concealedTextClass`, carrying the opt-out attributes the
// common extensions read (1Password, LastPass, Bitwarden, Dashlane). Spelling
// and autocorrect are off, as they are in a password field.
export const secretFieldAttributes = {
  type: 'text',
  autoComplete: 'off',
  autoCorrect: 'off',
  autoCapitalize: 'off',
  spellCheck: false,
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const

/** Draws a text field's text as dots, the way a password field does. The
 * placeholder stays readable. */
export const concealedTextClass = '[-webkit-text-security:disc]'

// A text field that holds what is typed and commits it once, on Enter or
// leaving the field; Escape puts the stored text back. Until something is
// typed it shows `value`, focused or not, so a change made elsewhere (another
// person's edit, an agent's) shows at once without re-mounting anything, and
// leaving the field without typing writes nothing back over it.
//
// Leaving the field is usually a press on another control beside it (an X, the
// key button). The commit lands between that press and its release, so the
// controls must survive it as the same elements: a re-mounted button never
// receives the release, and the click is lost.
export function CommitField({
  value,
  onCommit,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown'> & {
  value: string
  /** The text typed, when it differs from `value`. */
  onCommit: (text: string) => void
}) {
  const [text, setText] = useState<string>()
  const reverting = useRef(false)
  return (
    <InputGroupInput
      {...props}
      value={text ?? value}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          reverting.current = true
          event.currentTarget.blur()
        }
      }}
      onBlur={() => {
        setText(undefined)
        if (reverting.current) {
          reverting.current = false
          return
        }
        if (text !== undefined && text !== value) {
          onCommit(text)
        }
      }}
    />
  )
}

// The key button inside the field, and the list it opens: every secret by
// name, and on a field that takes a secret, the way back to a typed value, or
// to no secret on a field that takes no typed value.
function SecretMenu({
  value,
  secrets,
  secretLabel,
  allowTyped,
  noSecretsMessage,
  disabled,
  onPick,
}: {
  value: SecretValue
  secrets: string[]
  secretLabel: (secret: string) => string
  allowTyped: boolean
  noSecretsMessage: string
  disabled: boolean
  onPick: (value: SecretValue) => void
}) {
  const current = isSecretValue(value) ? value.secret : undefined
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <InputGroupButton size='icon-xs' aria-label={current ? 'Change the secret' : 'Use a secret'} />
        }
      >
        <KeyRound />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='min-w-48'>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Secrets</DropdownMenuLabel>
          {secrets.length === 0 ? (
            <DropdownMenuItem disabled>{noSecretsMessage}</DropdownMenuItem>
          ) : (
            secrets.map((name) => (
              <DropdownMenuItem
                key={name}
                className={cn('font-mono text-xs', name === current && 'font-semibold')}
                onClick={() => onPick({ secret: name })}
              >
                {secretLabel(name)}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
        {current !== undefined ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onPick({ value: '' })}>
              {allowTyped ? 'Type a value instead' : 'No secret'}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export interface SecretValueInputProps {
  value: SecretValue
  /** The names of the secrets a value can be taken from. Only names cross
   * this component, never a secret's value. Left out, the value is typed
   * only: the field has no key button. */
  secrets?: string[]
  /** A typed value, on Enter or leaving the field, or a secret picked. */
  onCommit: (value: SecretValue) => void
  /** The host's warning about this typed value, if it has one. */
  warning?: string
  /** Shown in the secret list when there is nothing to pick. */
  noSecretsMessage?: string
  /** What a secret is shown as, in the list and in the field. Without it,
   * its name. For secrets addressed by more than a name, such as a store and
   * a key. */
  secretLabel?: (secret: string) => string
  /** Whether a value can be typed (default). Without it the field only takes
   * a secret, and shows `placeholder` until one is picked. */
  allowTyped?: boolean
  placeholder?: string
  /** Typed text is drawn as dots, for a field whose text is a credential. */
  concealed?: boolean
  disabled?: boolean
  /** `flat` draws no frame of its own, for a field inside a table cell. */
  variant?: 'default' | 'flat'
  id?: string
  'aria-label'?: string
}

// The field itself. A typed value is a text field; a secret is its name,
// read-only, in the same frame, so the field keeps its height either way and
// a value is never on screen for a secret.
export function SecretValueInput({
  value,
  secrets,
  onCommit,
  warning,
  noSecretsMessage = NO_SECRETS,
  secretLabel = (secret) => secret,
  allowTyped = true,
  placeholder = allowTyped ? 'value' : 'No secret',
  concealed = false,
  disabled = false,
  variant = 'default',
  id,
  'aria-label': ariaLabel = 'Value',
}: SecretValueInputProps) {
  const missing = isSecretValue(value) && !secrets?.includes(value.secret)
  const typed = isSecretValue(value) ? '' : value.value
  const field = {
    ...secretFieldAttributes,
    id,
    className: cn('font-mono text-xs', concealed && concealedTextClass),
    'aria-label': ariaLabel,
    placeholder,
    disabled,
  }
  return (
    <InputGroup variant={variant} data-disabled={disabled || undefined}>
      {isSecretValue(value) ? (
        <InputGroupText
          id={id}
          className={cn('min-w-0 flex-1 pl-2.5 font-mono text-xs', missing ? 'text-destructive' : 'text-foreground')}
          title={missing ? 'Not found in any Secrets Store' : undefined}
        >
          {missing ? <CircleAlert /> : <KeyRound />}
          <span className='truncate'>{secretLabel(value.secret)}</span>
        </InputGroupText>
      ) : !allowTyped ? (
        <InputGroupText id={id} className='min-w-0 flex-1 pl-2.5 text-xs text-muted-foreground'>
          <span className='truncate'>{placeholder}</span>
        </InputGroupText>
      ) : (
        <>
          {/* Holds its place when empty, so a warning that comes or goes with
              a commit leaves the text field the same element. */}
          {warning ? (
            <InputGroupAddon align='inline-start' className='text-warning' title={warning}>
              <CircleAlert role='img' aria-label={warning} />
            </InputGroupAddon>
          ) : null}
          <CommitField {...field} value={typed} onCommit={(text) => onCommit({ value: text })} />
        </>
      )}
      <InputGroupAddon align='inline-end'>
        {secrets ? (
          <SecretMenu
            value={value}
            secrets={secrets}
            secretLabel={secretLabel}
            allowTyped={allowTyped}
            noSecretsMessage={noSecretsMessage}
            disabled={disabled}
            onPick={onCommit}
          />
        ) : null}
      </InputGroupAddon>
    </InputGroup>
  )
}

export interface SecretValueFieldProps {
  /** What the value is, above the field: "API key", "Password". */
  label: string
  value: SecretValue
  secrets: string[]
  /** A typed value, on Enter or leaving the field, or a secret picked. */
  onChange: (value: SecretValue) => void
  /** The host's warning about the typed value, as the sentence to show, or
   * undefined. The field is marked and the sentence shown under it. */
  warning?: string
  noSecretsMessage?: string
  /** What a secret is shown as, as `SecretValueInput` takes it. */
  secretLabel?: (secret: string) => string
  /** Whether a value can be typed (default); without it, only a secret. */
  allowTyped?: boolean
  placeholder?: string
  /** Typed text is drawn as dots. */
  concealed?: boolean
  disabled?: boolean
  className?: string
}

// One value a node uses as a credential, typed or taken from a stored secret by
// name: a label, the field, and the host's warning about a typed value under
// it, where a touch screen shows it too.
export function SecretValueField({
  label,
  value,
  secrets,
  onChange,
  warning,
  noSecretsMessage,
  secretLabel,
  allowTyped,
  placeholder,
  concealed,
  disabled,
  className,
}: SecretValueFieldProps) {
  const id = useId()
  const shownWarning = isSecretValue(value) ? undefined : warning
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Label htmlFor={id}>{label}</Label>
      <SecretValueInput
        id={id}
        aria-label={label}
        value={value}
        secrets={secrets}
        onCommit={onChange}
        warning={shownWarning}
        noSecretsMessage={noSecretsMessage}
        secretLabel={secretLabel}
        allowTyped={allowTyped}
        placeholder={placeholder}
        concealed={concealed}
        disabled={disabled}
      />
      {shownWarning ? <p className='text-xs text-warning'>{shownWarning}</p> : null}
    </div>
  )
}
