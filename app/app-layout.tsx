import { listSpaces } from '@/app/(space)/server/actions';
import { AppShell } from '@/app/app-shell';

export async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const spaces = await listSpaces();
  const pinnedSpaces = spaces.filter(s => s.pinned);
  return <AppShell pinnedSpaces={pinnedSpaces}>{children}</AppShell>;
}
