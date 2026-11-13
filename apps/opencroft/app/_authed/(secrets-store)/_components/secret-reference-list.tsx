import { describeSecretReference, type SecretKeyReferences } from '@/app/_authed/(secrets-store)/_lib/secret-references'

/** Who still names each secret, one line per secret: what a confirm shows before the secrets go. */
export function SecretReferenceList({ named }: { named: SecretKeyReferences[] }) {
  return (
    <ul className='flex flex-col gap-1 text-xs'>
      {named.map(({ key, references }) => (
        <li key={key}>
          <span className='font-mono'>{key}</span>: {references.map(describeSecretReference).join(', ')}
        </li>
      ))}
    </ul>
  )
}
