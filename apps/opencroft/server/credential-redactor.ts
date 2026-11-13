import type { CredentialRedactor, CredentialRedactorOptions } from '@opencroft/server/secrets'

import { createStreamRedactor, knownValues, MIN_VALUE_LENGTH, redactText } from '@/server/redact-text'
import { secrets } from '@/server/secrets'

/**
 * `credentialRedactor` of `@opencroft/server/secrets`: the text rules of `redact-text.ts` over the
 * values the Secrets Stores hold and the caller's own. Instance-wide on purpose: the text an
 * extension hands over (a container's output) is not tied to the node whose secrets it may carry.
 */
export async function credentialRedactor(options: CredentialRedactorOptions = {}): Promise<CredentialRedactor> {
  const stored = await secrets.listDecryptableValues()
  const values = knownValues([...stored, ...(options.values ?? [])], MIN_VALUE_LENGTH)
  return {
    minValueLength: MIN_VALUE_LENGTH,
    redact: (text) => redactText(text, values),
    stream: () => createStreamRedactor(values),
  }
}
