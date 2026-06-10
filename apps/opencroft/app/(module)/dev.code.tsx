import IFrame from 'ui/utils/iframe'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(module)/dev/code')({
  component: CodePage,
})

function CodePage() {
  return <IFrame title='Visual Studio Code' port={8443} />
}
