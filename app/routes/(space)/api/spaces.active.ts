import { createFileRoute } from '@tanstack/react-router';

import { getActiveSpaceSlug, setActiveSpaceSlug } from '@/app/(space)/server/actions';

export const Route = createFileRoute('/(space)/api/spaces/active')({
  server: {
    handlers: {
      GET: async () => {
        const slug = await getActiveSpaceSlug();
        return Response.json({ slug });
      },
      PUT: async ({ request }) => {
        const body = await request.json() as { slug?: string };
        if (!body.slug) {
          return Response.json({ error: 'Missing slug' }, { status: 400 });
        }
        await setActiveSpaceSlug({ data: body.slug });
        return Response.json({ ok: true });
      },
    },
  },
});
