import { NextResponse } from 'next/server';

import { createSpace, importSpace, listSpaces } from '@/app/(space)/server/actions';
import { type SpaceExport } from '@/app/(space)/server/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const spaces = await listSpaces();
  return NextResponse.json({ spaces });
}

export async function POST(request: Request) {
  const body = await request.json() as { name?: string; import?: SpaceExport };
  if (body.import) {
    const space = await importSpace(body.import);
    return NextResponse.json({ space }, { status: 201 });
  }
  const name = body.name ?? 'Space';
  const space = await createSpace(name);
  return NextResponse.json({ space }, { status: 201 });
}
