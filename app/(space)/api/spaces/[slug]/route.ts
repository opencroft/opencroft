import { NextResponse } from 'next/server';

import {
  deleteSpace,
  loadSpaceGraph,
  renameSpace,
  saveSpaceGraph,
} from '@/app/(space)/server/actions';
import { type GraphData } from '@/app/(space)/server/types';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ slug: string }>;
}

export async function GET(_request: Request, { params }: Params) {
  const { slug } = await params;
  const graph = await loadSpaceGraph(slug);
  if (!graph) {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }
  return NextResponse.json({ graph });
}

export async function PUT(request: Request, { params }: Params) {
  const { slug } = await params;
  const body = await request.json() as { graph?: GraphData };
  if (!body.graph) {
    return NextResponse.json({ error: 'Missing graph' }, { status: 400 });
  }
  await saveSpaceGraph(slug, body.graph);
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, { params }: Params) {
  const { slug } = await params;
  const body = await request.json() as { name?: string };
  if (!body.name) {
    return NextResponse.json({ error: 'Missing name' }, { status: 400 });
  }
  const space = await renameSpace(slug, body.name);
  if (!space) {
    return NextResponse.json({ error: 'Space not found' }, { status: 404 });
  }
  return NextResponse.json({ space });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { slug } = await params;
  const ok = await deleteSpace(slug);
  if (!ok) {
    return NextResponse.json({ error: 'Cannot delete' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
