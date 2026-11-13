import { Eye, EyeOff } from 'lucide-react'
import { type ComponentProps, useState } from 'react'

import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../input-group'
import { cn } from 'cn'

import { concealedTextClass, secretFieldAttributes } from './secret-value-field'

export interface SecretInputProps extends Omit<ComponentProps<typeof InputGroupInput>, 'type' | 'className'> {
  /** The value starts shown. */
  defaultRevealed?: boolean
  /** Reaches the frame, for its width and height. */
  className?: string
}

// A field holding a secret value, drawn as dots until the eye inside it is
// pressed. It is a text field with the password-manager opt-outs of
// `secretFieldAttributes`, never a password field, which they would read as a
// login. The eye is its only control: what acts on the secret (a menu, a
// copy button) sits beside the field. Every other prop reaches the text field.
export function SecretInput({ defaultRevealed = false, className, disabled, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = useState(defaultRevealed)
  return (
    <InputGroup data-disabled={disabled || undefined} className={className}>
      <InputGroupInput
        {...props}
        {...secretFieldAttributes}
        disabled={disabled}
        className={cn('h-full font-mono text-xs', !revealed && concealedTextClass)}
      />
      <InputGroupAddon align='inline-end'>
        <InputGroupButton
          size='icon-xs'
          aria-label={revealed ? 'Hide value' : 'Show value'}
          aria-pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
