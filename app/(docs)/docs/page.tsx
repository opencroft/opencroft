import { Suspense } from 'react';

import DocsPage from '@/app/(docs)/docs/_components/docs-page-client';

export default function Page() {
  return (
    <Suspense>
      <DocsPage />
    </Suspense>
  );
}
