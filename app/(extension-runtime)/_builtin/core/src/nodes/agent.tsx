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

export interface AgentData {
  name: string;
}

export function AgentNode({
  data, selected,
}: { id: string; data: AgentData; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.User}
      title={data.name || 'Agent'}
      selected={selected ?? false}
      input={<InputHandle type='agent-job' id='agent-in' />}
    />
  );
}

export function AgentInspector({
  data, updateData,
}: { nodeId: string; data: AgentData; updateData: (p: Partial<AgentData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='Agent name'
        />
      </div>
    </div>
  );
}
