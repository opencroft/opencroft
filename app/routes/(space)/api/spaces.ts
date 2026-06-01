import { createFileRoute } from '@tanstack/react-router';

import { createSpace, importSpace, listSpaces } from '@/app/(space)/server/actions';
import { type SpaceExport } from '@/app/(space)/server/types';

export const Route = createFileRoute('/(space)/api/spaces')({
  server: {
    handlers: {
      GET: async () => {
        const spaces = await listSpaces();
        return Response.json({ spaces });
      },
      POST: async ({ request }) => {
        const body = await request.json() as { name?: string; import?: SpaceExport };
        if (body.import) {
          const space = await importSpace({ data: body.import });
          return Response.json({ space }, { status: 201 });
        }
        const name = body.name ?? 'Space';
        const space = await createSpace({ data: name });
        return Response.json({ space }, { status: 201 });
      },
    },
  },
});
