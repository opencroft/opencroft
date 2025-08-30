export const dynamic = 'force-dynamic';

const UPSTREAM = process.env.ASR_URL ?? 'http://localhost:8881/v1/audio/transcriptions';

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  const body = await request.arrayBuffer();
  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
