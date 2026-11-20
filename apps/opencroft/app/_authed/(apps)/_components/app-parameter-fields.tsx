import type { AppParameter } from '@opencroft/core'
import { Field, FieldGroup, FieldLabel } from 'ui/field'
import { FieldHint } from 'ui/field-hint'
import { Input } from 'ui/input'

interface Props {
  parameters: AppParameter[]
  values: Record<string, string>
  onChange: (id: string, value: string) => void
}

/**
 * An App's parameters as the generic form draws them, when adding the App and in its settings alike:
 * one field per parameter, its description behind the label's hint.
 */
export function AppParameterFields({ parameters, values, onChange }: Props) {
  return (
    <FieldGroup className='max-w-md'>
      {parameters.map((spec) => (
        <Field key={spec.id}>
          <FieldHint about={spec.label} text={spec.description}>
            <FieldLabel htmlFor={`app-param-${spec.id}`}>
              {spec.label}
              {spec.required ? ' *' : ''}
            </FieldLabel>
          </FieldHint>
          <Input
            id={`app-param-${spec.id}`}
            value={values[spec.id] ?? ''}
            placeholder={spec.placeholder}
            autoComplete='off'
            onChange={(e) => onChange(spec.id, e.target.value)}
          />
        </Field>
      ))}
    </FieldGroup>
  )
}
