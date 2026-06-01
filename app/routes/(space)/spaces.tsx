import { createFileRoute } from '@tanstack/react-router';

import { listSpaces } from '@/app/(space)/server/actions';
import { SpacesTable } from '@/app/(space)/spaces/_components/spaces-table';

export const Route = createFileRoute('/(space)/spaces')({
  loader: () => listSpaces(),
  component: SpacesPage,
});

function SpacesPage() {
  const spaces = Route.useLoaderData();
  return <SpacesTable initialSpaces={spaces} />;
}
