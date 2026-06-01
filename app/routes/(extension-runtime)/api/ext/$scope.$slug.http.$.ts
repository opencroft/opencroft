import { createFileRoute } from '@tanstack/react-router';

import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader';

// Dispatches to an HTTP handler exposed by the extension's server module as
// `routes[<path>]`. The handler receives the raw Request and returns a
// (possibly streaming) Response — proxies, webhooks, SSE all work.
async function dispatch(request: Request, params: { scope: string; slug: string; _splat?: string }): Promise<Response> {
  const extensionId = `${params.scope}/${params.slug}`;
  const routeKey = (params._splat ?? '').split('/').filter(Boolean).join('/');
  let mod;
  try {
    mod = await getExtensionModule(extensionId);
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
  const handler = mod.routes?.[routeKey];
  if (!handler) {
    return new Response('Not found', { status: 404 });
  }
  return handler(request);
}

export const Route = createFileRoute('/(extension-runtime)/api/ext/$scope/$slug/http/$')({
  server: {
    handlers: {
      GET: ({ request, params }) => dispatch(request, params),
      POST: ({ request, params }) => dispatch(request, params),
      PUT: ({ request, params }) => dispatch(request, params),
      DELETE: ({ request, params }) => dispatch(request, params),
    },
  },
});
