import { listSpaces } from '@/app/_authed/(space)/_server/actions'
import { AppShell } from '@/app/_shell/app-shell'

export async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return <AppShell spaces={await listSpaces()}>{children}</AppShell>
}
