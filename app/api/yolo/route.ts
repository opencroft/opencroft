import { getYoloModeInfo } from '@/app/(mcp)/api/mcp/yolo';
import { NextResponse } from 'next/server';

export async function GET() {
  const info = getYoloModeInfo();
  return NextResponse.json(info);
}
