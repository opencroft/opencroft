import IFrame from '@opencroft/ui-kit/utils/iframe'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/(module)/chat')({
  component: ChatPage,
})

function ChatPage() {
  return <IFrame title='Open WebUI' port={8080} />
}
