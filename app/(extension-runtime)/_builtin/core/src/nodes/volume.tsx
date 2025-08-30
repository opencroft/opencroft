import {
  React,
  NodeFrame,
  OutputHandle,
  icons,
} from '@ext/host';
import {
  Input,
  Label,
} from '@ext/ui';

export interface VolumeData {
  name: string;
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export function VolumeNode({
  data, selected,
}: { id: string; data: VolumeData; selected?: boolean }) {
  return (
    <NodeFrame
      icon={icons.HardDrive}
      title={data.name || 'Volume'}
      selected={selected ?? false}
      output={<OutputHandle type='volume-mount' id='vol-out' />}
    />
  );
}

export function VolumeInspector({
  data, updateData,
}: { nodeId: string; data: VolumeData; updateData: (p: Partial<VolumeData>) => void }) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input
          value={data.name ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ name: e.target.value })}
          placeholder='my-volume'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Host Path</Label>
        <Input
          value={data.hostPath ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ hostPath: e.target.value })}
          placeholder='/data/myapp'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label>Container Path</Label>
        <Input
          value={data.containerPath ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ containerPath: e.target.value })}
          placeholder='/app/data'
        />
      </div>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.readOnly ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ readOnly: e.target.checked })}
        />
        Read-only
      </label>
    </div>
  );
}
