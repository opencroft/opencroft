import { NextResponse } from 'next/server';

import { exportSpace } from '@/app/(space)/server/actions';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  const { slug } = await params;
  const data = await exportSpace(slug);
  if (!data) {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="space-${slug}.json"`,
    },
  });
}
