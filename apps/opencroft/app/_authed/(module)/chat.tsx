import { createFileRoute } from '@tanstack/react-router'
import { IFrame } from 'ui/utils/iframe'

import { pageTitle } from '@/app/_lib/page-title'

export const Route = createFileRoute('/_authed/(module)/chat')({
  head: () => ({ meta: [{ title: pageTitle('Open WebUI') }] }),
  component: ChatPage,
})

function ChatPage() {
  return <IFrame title='Open WebUI' port={8080} />
}
