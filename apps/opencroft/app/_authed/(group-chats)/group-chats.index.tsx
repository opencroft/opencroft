import { createFileRoute } from '@tanstack/react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'

// The right panel before anything is open. Only seen side by side: below md
// the chats page shows its left panel alone until a chat is chosen.
export const Route = createFileRoute('/_authed/(group-chats)/group-chats/')({
  component: NothingOpen,
})

function NothingOpen() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Choose a chat</EmptyTitle>
        <EmptyDescription>Its threads open here, and a thread's conversation after them.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
