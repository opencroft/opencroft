'use client'

import { CodeEditor } from '@/components/code-editor'

interface CodePanelProps {
  value: string
  language: 'tsx' | 'json'
  readOnly?: boolean
  onChange: (value: string) => void
}

export function CodePanel({ value, language, readOnly, onChange }: CodePanelProps) {
  return (
    <div className='flex-1 min-h-0 min-w-0 overflow-hidden'>
      <CodeEditor value={value} language={language === 'tsx' ? 'typescript' : 'json'} readOnly={readOnly} onChange={onChange} />
    </div>
  )
}
