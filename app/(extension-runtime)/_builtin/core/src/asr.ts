export interface MicRecorder {
  stop: () => Promise<Blob>;
}

export interface VadRunner {
  stop: () => Promise<void>;
}

export interface VadCallbacks {
  onSpeechStart?: () => void;
  onUtterance: (blob: Blob) => void;
  onError?: (err: Error) => void;
}

const TARGET_SAMPLE_RATE = 16000;
const VAD_SAMPLE_RATE = 16000;

export async function startMicRecorder(): Promise<MicRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const src = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  src.connect(processor);
  processor.connect(ctx.destination);

  const stop = async (): Promise<Blob> => {
    processor.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    return encodeWav(chunks, ctx.sampleRate);
  };

  return { stop };
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i += 1) {
      const s = Math.max(-1, Math.min(1, c[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i += 1) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}

function encodeUtteranceWav(samples: Float32Array): Blob {
  return encodeWav([samples], VAD_SAMPLE_RATE);
}

export async function startVad(callbacks: VadCallbacks): Promise<VadRunner> {
  const { MicVAD } = await import('@ricky0123/vad-web');
  const vad = await MicVAD.new({
    baseAssetPath: '/vad/',
    onnxWASMBasePath: '/vad/',
    onSpeechStart: () => callbacks.onSpeechStart?.(),
    onSpeechEnd: (samples: Float32Array) => {
      callbacks.onUtterance(encodeUtteranceWav(samples));
    },
    onVADMisfire: () => {},
  });
  vad.start();
  return {
    stop: async () => {
      vad.pause();
      vad.destroy();
    },
  };
}

export interface StreamTranscribeOptions {
  blob: Blob;
  model?: string;
  url?: string;
  signal?: AbortSignal;
  onToken: (text: string) => void;
}

const METADATA_SENTINEL = '<asr_text>';
const END_SENTINEL = '</asr_text>';

export async function streamTranscribe(opts: StreamTranscribeOptions): Promise<void> {
  const form = new FormData();
  form.append('file', opts.blob, 'audio.wav');
  form.append('model', opts.model ?? 'Qwen/Qwen3-ASR-0.6B');
  form.append('stream', 'true');
  const res = await fetch(opts.url ?? '/api/asr/transcribe', {
    method: 'POST',
    body: form,
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const msg = await res.text().catch(() => '');
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let capturing = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf('\n\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 2);
      nl = buf.indexOf('\n\n');
      if (!line.startsWith('data:')) {
        continue;
      }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }
      let piece: string | undefined;
      try {
        const obj = JSON.parse(payload);
        piece = obj.choices?.[0]?.delta?.content;
      } catch {
        continue;
      }
      if (typeof piece !== 'string' || piece.length === 0) {
        continue;
      }
      if (!capturing) {
        const idx = piece.indexOf(METADATA_SENTINEL);
        if (idx === -1) {
          continue;
        }
        capturing = true;
        const after = piece.slice(idx + METADATA_SENTINEL.length);
        if (after) {
          emit(after, opts.onToken);
        }
        continue;
      }
      const endIdx = piece.indexOf(END_SENTINEL);
      if (endIdx !== -1) {
        emit(piece.slice(0, endIdx), opts.onToken);
        capturing = false;
        continue;
      }
      emit(piece, opts.onToken);
    }
  }
}

function emit(piece: string, onToken: (text: string) => void): void {
  if (piece) {
    onToken(piece);
  }
}
