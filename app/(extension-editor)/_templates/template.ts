export function extensionTemplate(slug: string): Record<string, string> {
  const id = `local/${slug}`;
  const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    'extension.json': JSON.stringify(
      {
        id,
        name,
        version: '0.0.1',
        description: 'A new local extension',
        nodes: [
          {
            typeId: `${slug}-node`,
            name: `${name} Node`,
            category: 'Custom',
            icon: 'Box',
          },
        ],
      },
      null,
      2,
    ) + '\n',

    'src/client.tsx': `import {
  defineExtension,
  NodeFrame,
  OutputHandle,
  icons,
} from '@ext/host';

const ${camelCase(slug)}Node = ({ data, selected }) => {
  return (
    <NodeFrame
      icon={icons.Box}
      title={data.title || '${name} Node'}
      selected={selected || false}
    >
      <OutputHandle type='signal'>
        <span className='text-xs'>out</span>
      </OutputHandle>
    </NodeFrame>
  );
};

const extension = defineExtension({
  manifest: { id: '${id}' },
  nodes: [
    {
      typeId: '${slug}-node',
      name: '${name} Node',
      category: 'Custom',
      icon: 'Box',
      defaultData: { title: 'Hello' },
      component: ${camelCase(slug)}Node,
    },
  ],
});

export default extension;
`,

    'server/index.ts': `// Server actions for this extension.
// Available: host.fs, host.os, host.exec, host.execFile, host.prisma, host.crypto

export const actions = {
  '${slug}-node.ping': async () => 'pong',
};
`,
  };
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
