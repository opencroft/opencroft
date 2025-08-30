export function pcmBytesToFloat32(bytes: Uint8Array, bitDepth: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bitDepth === 32) {
    const samples = Math.floor(bytes.byteLength / 4);
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      out[i] = view.getFloat32(i * 4, true);
    }
    return out;
  }
  const samples = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

export function concatPcmChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function pcmToWav(pcm: Uint8Array, sampleRate: number, bitDepth: number): Blob {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(pos + i, s.charCodeAt(i));
    }
  };
  const bytesPerSample = bitDepth / 8;
  const formatCode = bitDepth === 32 ? 3 : 1;
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatCode, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return new Blob([wav], { type: 'audio/wav' });
}

export interface ScheduleState {
  nextStart: number;
  leftover: Uint8Array | null;
}

export function newScheduleState(ctx: AudioContext): ScheduleState {
  return { nextStart: ctx.currentTime, leftover: null };
}

export interface ScheduleParams {
  ctx: AudioContext;
  dest: AudioNode;
  sampleRate: number;
  bitDepth: number;
  state: ScheduleState;
  chunk: Uint8Array;
}

export function schedulePcmChunk(params: ScheduleParams): void {
  const bytesPerSample = params.bitDepth / 8;
  let bytes = params.chunk;
  if (params.state.leftover) {
    const merged = new Uint8Array(params.state.leftover.byteLength + bytes.byteLength);
    merged.set(params.state.leftover);
    merged.set(bytes, params.state.leftover.byteLength);
    bytes = merged;
    params.state.leftover = null;
  }
  const aligned = bytes.byteLength - (bytes.byteLength % bytesPerSample);
  if (aligned < bytes.byteLength) {
    params.state.leftover = bytes.slice(aligned);
  }
  if (aligned === 0) {
    return;
  }
  const floats = pcmBytesToFloat32(bytes.subarray(0, aligned), params.bitDepth);
  const buffer = params.ctx.createBuffer(1, floats.length, params.sampleRate);
  buffer.getChannelData(0).set(floats);
  const src = params.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(params.dest);
  const when = Math.max(params.state.nextStart, params.ctx.currentTime);
  src.start(when);
  params.state.nextStart = when + buffer.duration;
}
