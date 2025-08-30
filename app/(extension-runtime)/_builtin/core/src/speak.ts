import { schedulePcmChunk, type ScheduleState } from './audio-pcm';

export interface SpeakParams {
  ctx: AudioContext;
  dest: AudioNode;
  state: ScheduleState;
  sampleRate: number;
  bitDepth: 16 | 32;
  apiBase: string;
  apiKey: string;
  model: string;
  voice: string;
  speed: number;
  trimStartSamples: number;
  trimEndSamples: number;
  signal?: AbortSignal;
}

export async function speakSentence(sentence: string, params: SpeakParams): Promise<void> {
  const bytesPerSample = params.bitDepth / 8;
  const trimStartBytes = Math.max(0, params.trimStartSamples) * bytesPerSample;
  const trimEndBytes = Math.max(0, params.trimEndSamples) * bytesPerSample;

  const res = await fetch('/api/openai-speech-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      model: params.model,
      voice: params.voice,
      input: sentence,
      format: 'pcm',
      speed: params.speed,
      stream: true,
    }),
    signal: params.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`TTS failed: ${text || res.status}`);
  }

  const reader = res.body.getReader();
  let skipRemaining = trimStartBytes;
  let tail = new Uint8Array(0);

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    let chunk = value;
    if (skipRemaining > 0) {
      if (chunk.byteLength <= skipRemaining) {
        skipRemaining -= chunk.byteLength;
        continue;
      }
      chunk = chunk.subarray(skipRemaining);
      skipRemaining = 0;
    }
    const merged = new Uint8Array(tail.byteLength + chunk.byteLength);
    merged.set(tail);
    merged.set(chunk, tail.byteLength);
    if (merged.byteLength > trimEndBytes) {
      const splitAt = merged.byteLength - trimEndBytes;
      schedulePcmChunk({
        ctx: params.ctx,
        dest: params.dest,
        sampleRate: params.sampleRate,
        bitDepth: params.bitDepth,
        state: params.state,
        chunk: merged.subarray(0, splitAt),
      });
      tail = merged.slice(splitAt);
    } else {
      tail = merged;
    }
  }
}
