import {
  React,
  NodeFrame,
  InputHandle,
  icons,
} from '@ext/host';
import {
  Input,
  Label,
} from '@ext/ui';

export interface SendMessageData {
  sessionKey: string;
}

export function SendMessageNode({
  data, selected,
}: { id: string; data: SendMessageData; selected?: boolean }) {
  const hasKey = Boolean(data.sessionKey?.trim());
  return (
    <NodeFrame
      icon={icons.Send}
      title='Send Message'
      subtitle={hasKey ? data.sessionKey : 'No session'}
      selected={selected ?? false}
      input={<InputHandle type='text-stream' id='text-in' />}
    />
  );
}

export function SendMessageInspector({
  data, updateData,
}: { nodeId: string; data: SendMessageData; updateData: (p: Partial<SendMessageData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Session Key</Label>
        <Input
          value={data.sessionKey ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ sessionKey: e.target.value })}
          placeholder='Agent session key'
        />
        <span className='text-[10px] text-muted-foreground'>
          The session key of the agent to send messages to.
        </span>
      </div>
    </div>
  );
}

export const SEND_MESSAGE_HANDLES = [
  { id: 'text-in', contextType: 'text-stream', role: 'target' as const, label: 'Text' },
];
