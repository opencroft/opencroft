import { NextResponse } from 'next/server';

import { invokeExtensionAction } from '@/app/(extension-runtime)/_server/actions';

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { extensionId, action, args } = body as {
    extensionId?: string;
    action?: string;
    args?: unknown[];
  };

  if (!extensionId || !action) {
    return NextResponse.json(
      { error: 'Missing extensionId or action' },
      { status: 400 },
    );
  }

  try {
    const result = await invokeExtensionAction(extensionId, action, args ?? []);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
