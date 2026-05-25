import { NextResponse } from 'next/server';

import { getExtensionModule } from '@/app/(extension-runtime)/_server/loader';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ scope: string; slug: string; path: string[] }>;
}

// Dispatches to an HTTP handler exposed by the extension's server module as
// `routes[<path>]`. The handler receives the raw Request and returns a
// (possibly streaming) Response — proxies, webhooks, SSE all work.
async function dispatch(req: Request, paramsPromise: RouteParams['params']): Promise<Response> {
  const { scope, slug, path } = await paramsPromise;
  const extensionId = `${scope}/${slug}`;
  const routeKey = path.join('/');
  let mod;
  try {
    mod = await getExtensionModule(extensionId);
  } catch (err) {
    return new NextResponse(String(err), { status: 500 });
  }
  const handler = mod.routes?.[routeKey];
  if (!handler) {
    return new NextResponse('Not found', { status: 404 });
  }
  return handler(req);
}

export function GET(req: Request, { params }: RouteParams) {
  return dispatch(req, params);
}

export function POST(req: Request, { params }: RouteParams) {
  return dispatch(req, params);
}

export function PUT(req: Request, { params }: RouteParams) {
  return dispatch(req, params);
}

export function DELETE(req: Request, { params }: RouteParams) {
  return dispatch(req, params);
}
