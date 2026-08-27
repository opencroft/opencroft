import { createFileRoute } from '@tanstack/react-router'
import { IFrame } from 'ui/utils/iframe'

export const Route = createFileRoute('/_authed/(module)/dev/database')({
  component: DatabasePage,
})

function DatabasePage() {
  return <IFrame title='Database' port={8081} />
}
