import {
  React,
  NodeFrame,
  InputHandle,
  OutputHandle,
  defineExtension,
  icons,
  toast,
  useNodeContext,
  invoke,
} from '@ext/host';
import { Button, Input, Label } from '@ext/ui';

interface GreeterData {
  name: string;
  greetings: number;
}

interface ListenerData {
  lastHeard: string;
}

interface HelloMessage {
  text: string;
  from: string;
}

const GREETER_HANDLES = [
  { id: 'message-out', contextType: 'hello-message', role: 'source', label: 'Msg' },
] as const;

const LISTENER_HANDLES = [
  { id: 'message-in', contextType: 'hello-message', role: 'target', label: 'Msg' },
] as const;

function GreeterNode({ data, selected }: { data: GreeterData; selected?: boolean }) {
  const Icon = icons.Sparkles;
  return (
    <NodeFrame
      icon={Icon}
      title={`Hello, ${data.name || 'World'}`}
      subtitle={`${data.greetings ?? 0} greetings`}
      selected={selected ?? false}
      output={<OutputHandle type='hello-message' id='message-out' />}
    />
  );
}

function GreeterInspector({
  nodeId,
  data,
  updateData,
}: {
  nodeId: string;
  data: GreeterData;
  updateData: (patch: Partial<GreeterData>) => void;
}) {
  const handleGreet = React.useCallback(async () => {
    const response = await invoke<string>('greeter.greet', data.name || 'World');
    toast.success(response);
    updateData({ greetings: (data.greetings ?? 0) + 1 });
  }, [data.name, data.greetings, updateData]);

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label>Name</Label>
        <Input value={data.name ?? ''} onChange={(e) => updateData({ name: e.target.value })} />
      </div>
      <div className='text-xs text-muted-foreground'>Node {nodeId}</div>
      <Button onClick={handleGreet}>Greet via server action</Button>
    </div>
  );
}

function ListenerNode({ id, data, selected }: { id: string; data: ListenerData; selected?: boolean }) {
  const Icon = icons.Ear;
  const ctx = useNodeContext<HelloMessage>(id, 'message-in');
  const subtitle = ctx ? `Heard: ${ctx.value.text}` : data.lastHeard || 'listening…';
  return (
    <NodeFrame
      icon={Icon}
      title='Listener'
      subtitle={subtitle}
      selected={selected ?? false}
      input={<InputHandle type='hello-message' id='message-in' />}
    />
  );
}

function ListenerInspector({
  data,
}: {
  nodeId: string;
  data: ListenerData;
  updateData: (patch: Partial<ListenerData>) => void;
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='text-xs text-muted-foreground'>
        Connect a Greeter&apos;s <code>Msg</code> output to this node&apos;s <code>Msg</code> input.
      </div>
      <div className='text-xs'>Last heard: {data.lastHeard || '(none)'}</div>
    </div>
  );
}

export default defineExtension({
  manifest: {
    id: 'builtin/hello',
    name: 'Hello',
    version: '1.0.0',
    description: 'Multi-node reference extension with context wiring',
  },
  contexts: [
    {
      id: 'hello-message',
      label: 'Hello Message',
      color: 'oklch(0.7 0.17 320)',
    },
  ],
  nodes: [
    {
      typeId: 'hello-greeter',
      name: 'Greeter',
      category: 'Demo',
      icon: 'Sparkles',
      accent: 'oklch(0.7 0.17 320)',
      handles: GREETER_HANDLES as unknown as never[],
      defaultData: { name: 'World', greetings: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      component: GreeterNode as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inspector: GreeterInspector as any,
      exposeOutput: (handleId, data) => {
        if (handleId !== 'message-out') {
          return undefined;
        }
        const d = data as GreeterData;
        return { text: `Hello, ${d.name || 'World'}`, from: 'greeter' };
      },
    },
    {
      typeId: 'hello-listener',
      name: 'Listener',
      category: 'Demo',
      icon: 'Ear',
      accent: 'oklch(0.72 0.16 200)',
      handles: LISTENER_HANDLES as unknown as never[],
      defaultData: { lastHeard: '' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      component: ListenerNode as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inspector: ListenerInspector as any,
    },
  ],
});
