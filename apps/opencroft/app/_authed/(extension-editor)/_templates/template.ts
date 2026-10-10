/**
 * The files of a new extension called `slug`. Neither the manifest nor the
 * client names an id: the extension runs under the name of the folder it is
 * created in (`local.<slug>`), and the runtime supplies that id to both.
 */
export function extensionTemplate(slug: string): Record<string, string> {
  const name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  const manifest = {
    name,
    version: '0.0.1',
    description: 'A new local extension',
    nodes: [
      {
        type: `${slug}-node`,
        name: `${name} Node`,
        category: 'Custom',
        icon: 'Box',
      },
    ],
  }

  return {
    'extension.json': `${JSON.stringify(manifest, null, 2)}\n`,

    'src/client.tsx': `import { NodeFrame, OutputHandle } from '@opencroft/client/canvas';
import { defineExtension } from '@opencroft/client/extension';
import { Box } from 'lucide-react';

const ${camelCase(slug)}Node = ({ data, selected }) => {
  return (
    <NodeFrame
      icon={Box}
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
  manifest: { name: '${name}' },
  nodes: [
    {
      type: '${slug}-node',
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
// The host is imported from its modules, for example:
//   import { exec, execFile, fs, os } from '@opencroft/server/system'
//   import { secrets } from '@opencroft/server/secrets'

export const actions = {
  '${slug}-node.ping': async () => 'pong',
};
`,
  }
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}
