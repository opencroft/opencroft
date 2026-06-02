import { createFileRoute } from '@tanstack/react-router'

import IFrame from '@opencroft/ui-kit/utils/iframe'

export const Route = createFileRoute('/(module)/dev/code')({
  component: CodePage,
})

function CodePage() {
  return <IFrame title='Visual Studio Code' port={8443} />
}
