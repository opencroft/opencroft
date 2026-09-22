import { createFileRoute } from '@tanstack/react-router'
import { IFrame } from 'ui/utils/iframe'

import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(module)/dev/code')({
  head: () => ({ meta: [{ title: pageTitle('Visual Studio Code') }] }),
  component: CodePage,
})

function CodePage() {
  return <IFrame title='Visual Studio Code' port={8443} />
}
