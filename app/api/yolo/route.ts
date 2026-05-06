import { NextResponse } from 'next/server';

import { getYoloModeInfo } from '@/app/(mcp)/api/mcp/yolo';

export async function GET() {
  const info = getYoloModeInfo();
  return NextResponse.json(info);
}
