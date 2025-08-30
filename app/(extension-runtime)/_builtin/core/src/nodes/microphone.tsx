import {
  React,
  NodeFrame,
  OutputHandle,
  broadcast,
  getStream,
  icons,
  toast,
  type AudioChunk,
  type Stream,
} from '@ext/host';
import { Button } from '@ext/ui';

import {
  type MicRecorder,
  startMicRecorder,
  startVad,
  type VadRunner,
} from '../asr';

const { useCallback, useEffect, useRef, useState } = React;

export interface MicrophoneData {
  mode: 'ptt' | 'vad';
}

export function MicrophoneNode({ id, data, selected }: { id: string; data: MicrophoneData; selected?: boolean }) {
  const mode = data.mode ?? 'ptt';
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MicRecorder | null>(null);
  const vadRef = useRef<VadRunner | null>(null);

  useEffect(() => {
    return () => {
      recorderRef.current?.stop().catch(() => {});
      vadRef.current?.stop().catch(() => {});
    };
  }, []);

  const emit = useCallback((blob: Blob) => {
    const stream = getStream<AudioChunk>(id, 'audio-out');
    broadcast(stream, { data: blob, final: true });
  }, [id]);

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
      if (rec) {
        emit(await rec.stop());
      }
      return;
    }
    try {
      if (mode === 'vad') {
        vadRef.current = await startVad({ onUtterance: emit });
      } else {
        recorderRef.current = await startMicRecorder();
      }
      setRecording(true);
    } catch (err) {
      toast.error(`Mic access failed: ${(err as Error).message}`);
    }
  }, [recording, mode, emit]);

  return (
    <NodeFrame
      icon={icons.Mic}
      title='Microphone'
      subtitle={mode === 'vad' ? 'Continuous (VAD)' : 'Push to talk'}
      selected={selected ?? false}
      loading={recording}
      output={<OutputHandle type='audio-stream' id='audio-out' />}
      extra={
        <div className='nodrag nopan flex items-center gap-1'>
          <Button
            variant='ghost'
            size='icon'
            className='h-7 w-7 shrink-0'
            onClick={toggle}
            title={recording ? 'Stop recording' : 'Record'}
          >
            <icons.Mic className={`h-3 w-3 ${recording ? 'text-red-500' : 'text-muted-foreground'}`} />
          </Button>
        </div>
      }
    />
  );
}

export function MicrophoneInspector({ data, updateData }: { nodeId: string; data: MicrophoneData; updateData: (p: Partial<MicrophoneData>) => void }) {
  return (
    <div className='flex flex-col gap-2'>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='radio'
          name='mic-mode'
          checked={(data.mode ?? 'ptt') === 'ptt'}
          onChange={() => updateData({ mode: 'ptt' })}
        />
        Push to talk
      </label>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='radio'
          name='mic-mode'
          checked={data.mode === 'vad'}
          onChange={() => updateData({ mode: 'vad' })}
        />
        Continuous (VAD)
      </label>
    </div>
  );
}

export const MICROPHONE_HANDLES = [
  { id: 'audio-out', contextType: 'audio-stream', role: 'source' as const, label: 'Audio' },
];

export function microphoneExposeOutput(handleId: string, _data: unknown, _typeId: string, nodeId: string): Stream<AudioChunk> | undefined {
  if (handleId === 'audio-out') {
    return getStream<AudioChunk>(nodeId, 'audio-out');
  }
  return undefined;
}
