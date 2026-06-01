import { createFileRoute } from '@tanstack/react-router';

import IFrame from '@/components/ui/utils/iframe';

export const Route = createFileRoute('/(module)/dev/database')({
  component: DatabasePage,
});

function DatabasePage() {
  return <IFrame title='Database' port={8081} />;
}
