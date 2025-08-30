interface SpeechRequest {
  apiBase: string;
  apiKey: string;
  model: string;
  voice: string;
  input: string;
  format: string;
  speed: number;
  stream: boolean;
  instructions?: string;
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};

export async function POST(req: Request): Promise<Response> {
  const params = await req.json() as SpeechRequest;
  const base = (params.apiBase || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const format = params.format || 'mp3';

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.apiKey?.trim()) {
    headers['Authorization'] = `Bearer ${params.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: params.model,
    voice: params.voice,
    input: params.input,
    response_format: format,
    speed: params.speed,
    stream: params.stream,
  };
  if (params.instructions?.trim()) {
    body.instructions = params.instructions;
  }

  const upstream = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': MIME_BY_FORMAT[format] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    },
  });
}
