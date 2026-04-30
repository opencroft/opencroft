import {
  React,
  NodeFrame,
  InputHandle,
  icons,
} from '@ext/host';
import {
  Button,
  Input,
  Label,
} from '@ext/ui';

const { useCallback, useRef } = React;

export interface AgentData {
  name: string;
  avatar?: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
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
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    const url = await readAsDataUrl(file);
    updateData({ avatar: url });
    e.target.value = '';
  }, [updateData]);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Avatar</Label>
        <div className='flex items-center gap-2'>
          <div className='h-12 w-12 rounded-full overflow-hidden bg-muted flex items-center justify-center shrink-0'>
            {data.avatar ? (
              <img src={data.avatar} alt='' className='h-full w-full object-cover' />
            ) : (
              <icons.User className='h-5 w-5 text-muted-foreground' />
            )}
          </div>
          <Button
            variant='outline'
            size='sm'
            onClick={() => inputRef.current?.click()}
          >
            <icons.Upload className='h-3 w-3 mr-1' />
            {data.avatar ? 'Change' : 'Upload'}
          </Button>
          {data.avatar ? (
            <Button
              variant='ghost'
              size='sm'
              onClick={() => updateData({ avatar: undefined })}
            >
              <icons.Trash2 className='h-3 w-3' />
            </Button>
          ) : null}
          <input
            ref={inputRef}
            type='file'
            accept='image/*'
            className='hidden'
            onChange={handlePick}
          />
        </div>
      </div>
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
