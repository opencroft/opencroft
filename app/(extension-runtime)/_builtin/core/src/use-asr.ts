import { React, toast } from '@ext/host';

import {
  type MicRecorder,
  startMicRecorder,
  startVad,
  streamTranscribe,
  type VadRunner,
} from './asr';

const { useCallback, useRef, useState } = React;

export type AsrMode = 'ptt' | 'vad';

export interface UseAsrOptions {
  onText: (piece: string) => void;
  mode?: AsrMode;
  model?: string;
  url?: string;
}

export interface UseAsrResult {
  recording: boolean;
  transcribing: boolean;
  mode: AsrMode;
  toggle: () => Promise<void>;
  cancel: () => void;
}

export function useAsr(options: UseAsrOptions): UseAsrResult {
  const mode = options.mode ?? 'ptt';
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recorderRef = useRef<MicRecorder | null>(null);
  const vadRef = useRef<VadRunner | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const firstUtteranceRef = useRef(true);

  const onTextRef = useRef(options.onText);
  onTextRef.current = options.onText;

  const transcribe = useCallback(async (blob: Blob, prefix = '') => {
    setTranscribing(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (prefix) {
        onTextRef.current(prefix);
      }
      await streamTranscribe({
        blob,
        model: options.model,
        url: options.url,
        signal: controller.signal,
        onToken: (piece: string) => onTextRef.current(piece),
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        toast.error(`Transcription failed: ${(err as Error).message}`);
      }
    } finally {
      setTranscribing(false);
      abortRef.current = null;
    }
  }, [options.model, options.url]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec) {
      rec.stop().catch(() => {});
    }
    const vad = vadRef.current;
    vadRef.current = null;
    if (vad) {
      vad.stop().catch(() => {});
    }
    setRecording(false);
    setTranscribing(false);
  }, []);

  const toggle = useCallback(async () => {
    if (recording) {
      if (mode === 'vad') {
        const vad = vadRef.current;
        vadRef.current = null;
        setRecording(false);
        if (vad) {
          await vad.stop();
        }
        return;
      }
      const rec = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!rec) {
        return;
      }
      const blob = await rec.stop();
      await transcribe(blob);
      return;
    }
    try {
      if (mode === 'vad') {
        firstUtteranceRef.current = true;
        vadRef.current = await startVad({
          onUtterance: (blob: Blob) => {
            const prefix = firstUtteranceRef.current ? '' : ' ';
            firstUtteranceRef.current = false;
            transcribe(blob, prefix).catch(() => {});
          },
        });
      } else {
        recorderRef.current = await startMicRecorder();
      }
      setRecording(true);
    } catch (err) {
      toast.error(`Mic access failed: ${(err as Error).message}`);
    }
  }, [recording, mode, transcribe]);

  return { recording, transcribing, mode, toggle, cancel };
}
