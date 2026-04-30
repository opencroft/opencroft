import { listSpaces } from '@/app/(space)/server/actions';
import { SpacesTable } from '@/app/(space)/spaces/_components/spaces-table';

export const dynamic = 'force-dynamic';

export default async function SpacesPage() {
  const spaces = await listSpaces();
  return <SpacesTable initialSpaces={spaces} />;
}
