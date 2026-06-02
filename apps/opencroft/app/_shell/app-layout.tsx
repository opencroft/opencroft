import { AppShell } from '@/app/_shell/app-shell'
import { listSpaces } from '@/app/(space)/_server/actions'

export async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const spaces = await listSpaces()
  const pinnedSpaces = spaces.filter((s) => s.pinned)
  return <AppShell pinnedSpaces={pinnedSpaces}>{children}</AppShell>
}
