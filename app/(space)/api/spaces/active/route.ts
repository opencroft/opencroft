import { NextResponse } from 'next/server';

import { getActiveSpaceSlug, setActiveSpaceSlug } from '@/app/(space)/server/actions';

export const dynamic = 'force-dynamic';

export async function GET() {
  const slug = await getActiveSpaceSlug();
  return NextResponse.json({ slug });
}

export async function PUT(request: Request) {
  const body = await request.json() as { slug?: string };
  if (!body.slug) {
    return NextResponse.json({ error: 'Missing slug' }, { status: 400 });
  }
  await setActiveSpaceSlug(body.slug);
  return NextResponse.json({ ok: true });
}
