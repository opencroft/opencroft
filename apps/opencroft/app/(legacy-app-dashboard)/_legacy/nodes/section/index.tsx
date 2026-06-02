'use client'

import { Input } from '@opencroft/ui-kit/input'
import { Label } from '@opencroft/ui-kit/label'
import type { Node, NodeProps } from '@xyflow/react'
import { Boxes, Globe } from 'lucide-react'
import type { NodeSettingsProps, NodeTypeDefinition } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { useSettingsDraft } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/use-settings-draft'
import { InvisibleResizer } from '@/app/(legacy-app-dashboard)/_legacy/nodes/shared/invisible-resizer'

export type SectionData = {
  label: string
  color: string
}

export type SectionNode = Node<SectionData, 'section'>

const COLORS = ['oklch(0.6 0.15 250)', 'oklch(0.6 0.15 150)', 'oklch(0.6 0.15 30)', 'oklch(0.6 0.15 320)', 'oklch(0.6 0.15 60)']

function SectionComponent({ id, data }: NodeProps<SectionNode>) {
  return (
    <>
      <InvisibleResizer id={id} minWidth={200} minHeight={160} />
      <div
        className='h-full w-full rounded-lg p-3'
        style={{
          backgroundColor: `color-mix(in oklch, ${data.color} 8%, transparent)`,
          border: `1px dashed color-mix(in oklch, ${data.color} 40%, transparent)`,
        }}
      >
        <div className='flex items-center gap-1.5'>
          <Boxes className='h-3.5 w-3.5' style={{ color: data.color }} />
          <span className='text-xs font-semibold' style={{ color: data.color }}>
            {data.label}
          </span>
        </div>
      </div>
    </>
  )
}

function SectionSettings(props: NodeSettingsProps<SectionData>) {
  const { draft, update } = useSettingsDraft(props)
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Label</Label>
        <Input value={draft.label ?? ''} onChange={(e) => update({ label: e.target.value })} className='h-7 text-xs' />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Color</Label>
        <div className='flex gap-1'>
          {COLORS.map((c) => (
            <button
              key={c}
              className='h-6 w-6 rounded-full border-2'
              style={{
                backgroundColor: c,
                borderColor: draft.color === c ? 'white' : 'transparent',
              }}
              onClick={() => update({ color: c })}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)]
}

export const sectionDefinition: NodeTypeDefinition<SectionData> = {
  type: 'section',
  label: 'Section',
  icon: Boxes,
  group: 'Organization',
  defaultData: () => ({
    label: 'Section',
    color: randomColor(),
  }),
  component: SectionComponent,
  settings: SectionSettings,
}

export const domainDefinition: NodeTypeDefinition<SectionData> = {
  type: 'domain',
  label: 'Domain',
  icon: Globe,
  group: 'Organization',
  defaultData: () => ({
    label: 'Domain',
    color: randomColor(),
  }),
  component: SectionComponent,
  settings: SectionSettings,
}
