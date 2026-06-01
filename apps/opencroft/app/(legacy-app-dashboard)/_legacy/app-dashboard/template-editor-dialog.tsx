'use client'

import { useEffect, useState } from 'react'

import { useCustomTemplates } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/custom-templates-context'
import type { CustomTemplate } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/types'
import { Button } from '@opencroft/ui-kit/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@opencroft/ui-kit/dialog'
import { Input } from '@opencroft/ui-kit/input'
import { Label } from '@opencroft/ui-kit/label'
import { Textarea } from '@opencroft/ui-kit/textarea'

const STARTER_CODE = `// Scope: React, h (React.createElement), useState, useCallback, useEffect,
//   useRef, useMemo, useReactFlow, useSettingsDraft,
//   icons (all lucide), PinnedNode, ButtonPin,
//   HANDLE_EXECUTION, HANDLE_FILESYSTEM, ui.{ Button, Input, Label, Textarea }

return {
  label: 'My Node',
  icon: icons.Box,
  color: 'oklch(0.65 0.15 150)',
  group: 'Custom',
  defaultData: () => ({ name: '' }),

  component({ data, selected }) {
    return h(PinnedNode, {
      selected,
      accent: 'oklch(0.65 0.15 150)',
      icon: icons.Box,
      title: data.name || 'My Node',
    });
  },

  settings(props) {
    const { draft, update } = useSettingsDraft(props);
    return h('div', { className: 'flex flex-col gap-3' },
      h(ui.Label, { className: 'text-xs' }, 'Name'),
      h(ui.Input, {
        value: draft.name ?? '',
        onChange: e => update({ name: e.target.value }),
        className: 'h-7 text-xs',
      }),
    );
  },
};
`

interface TemplateEditorDialogProps {
  template: CustomTemplate | null
  open: boolean
  onClose: () => void
}

export function TemplateEditorDialog({ template, open, onClose }: TemplateEditorDialogProps) {
  const { upsertTemplate, deleteTemplate } = useCustomTemplates()
  const [name, setName] = useState('')
  const [code, setCode] = useState(STARTER_CODE)

  useEffect(() => {
    if (open) {
      setName(template?.name ?? '')
      setCode(template?.code ?? STARTER_CODE)
    }
  }, [open, template])

  const save = async () => {
    const id = template?.id ?? crypto.randomUUID()
    await upsertTemplate({ id, name, code })
    onClose()
  }

  const remove = async () => {
    if (template) {
      await deleteTemplate(template.id)
    }
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className='max-w-2xl flex flex-col' style={{ height: '80vh' }}>
        <DialogHeader>
          <DialogTitle>{template ? 'Edit Node Type' : 'New Node Type'}</DialogTitle>
        </DialogHeader>
        <div className='flex flex-col gap-3 flex-1 overflow-hidden'>
          <div className='flex flex-col gap-1'>
            <Label className='text-xs'>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className='h-7 text-xs' placeholder='My Custom Node' />
          </div>
          <div className='flex flex-col gap-1 flex-1 overflow-hidden'>
            <Label className='text-xs'>Code</Label>
            <Textarea value={code} onChange={(e) => setCode(e.target.value)} className='flex-1 text-xs font-mono resize-none' spellCheck={false} />
          </div>
        </div>
        <div className='flex gap-2 justify-end pt-2'>
          {template && (
            <Button variant='destructive' size='sm' onClick={remove}>
              Delete
            </Button>
          )}
          <Button size='sm' disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
