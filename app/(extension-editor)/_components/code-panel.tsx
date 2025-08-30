'use client';

import { javascript } from '@codemirror/lang-javascript';
import CodeMirror from '@uiw/react-codemirror';
import { useTheme } from 'next-themes';

interface CodePanelProps {
  value: string;
  language: 'tsx' | 'json';
  readOnly?: boolean;
  onChange: (value: string) => void;
}

export function CodePanel({ value, language, readOnly, onChange }: CodePanelProps) {
  const { resolvedTheme } = useTheme();
  const jsx = language === 'tsx';

  return (
    <div className='flex-1 min-h-0 min-w-0 overflow-hidden'>
      <CodeMirror
        value={value}
        height='100%'
        style={{ height: '100%' }}
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        extensions={[javascript({ jsx, typescript: true })]}
        editable={!readOnly}
        onChange={onChange}
      />
    </div>
  );
}
