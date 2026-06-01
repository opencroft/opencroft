import { createFileRoute } from '@tanstack/react-router'

import IFrame from '@/components/ui/utils/iframe'

export const Route = createFileRoute('/(module)/chat')({
  component: ChatPage,
})

function ChatPage() {
  return <IFrame title='Open WebUI' port={8080} />
}
