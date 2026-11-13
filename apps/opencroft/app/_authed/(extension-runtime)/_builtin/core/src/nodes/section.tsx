import { CanvasFrame } from '@opencroft/client/canvas'
import { Checkbox, Field, FieldContent, FieldDescription, FieldLabel, Input, Label, Slider } from '@opencroft/client/ui'
import { Boxes } from 'lucide-react'
import { useId } from 'react'

import { COLUMN_GAP_STEPS, columnGapSteps, type SectionData } from './section-shared'

const SECTION_COLORS = [
  'oklch(0.6 0.15 250)',
  'oklch(0.6 0.15 150)',
  'oklch(0.6 0.15 30)',
  'oklch(0.6 0.15 320)',
  'oklch(0.6 0.15 60)',
]

export function randomSectionColor(): string {
  return SECTION_COLORS[Math.floor(Math.random() * SECTION_COLORS.length)]
}

export function SectionNode({ id, data, selected }: { id: string; data: SectionData; selected?: boolean }) {
  return (
    <CanvasFrame
      id={id}
      selected={selected}
      color={data.color || 'oklch(0.6 0.15 250)'}
      icon={Boxes}
      label={data.label || 'Section'}
    />
  )
}

export function SectionInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: SectionData
  updateData: (p: Partial<SectionData>) => void
}) {
  const id = useId()
  const gap = columnGapSteps(data.columnGapSteps)
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Label</Label>
        <Input
          value={data.label ?? ''}
          onChange={(e) => updateData({ label: e.target.value })}
          className='h-7 text-xs'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Color</Label>
        <div className='flex gap-1'>
          {SECTION_COLORS.map((c) => (
            <button
              type='button'
              key={c}
              className='h-6 w-6 rounded-full border-2'
              style={{
                backgroundColor: c,
                borderColor: data.color === c ? 'white' : 'transparent',
              }}
              onClick={() => updateData({ color: c })}
            />
          ))}
        </div>
      </div>
      <Field orientation='horizontal'>
        <Checkbox
          id={`${id}-autolayout`}
          checked={data.autolayout === true}
          onCheckedChange={(checked) => updateData({ autolayout: checked === true })}
          aria-describedby={`${id}-autolayout-description`}
        />
        <FieldContent>
          <FieldLabel htmlFor={`${id}-autolayout`} className='text-xs'>
            Autolayout
          </FieldLabel>
          <FieldDescription id={`${id}-autolayout-description`} className='text-xs'>
            Keeps the nodes inside tidied up and the section fitted around them.
          </FieldDescription>
        </FieldContent>
      </Field>
      {data.autolayout === true && (
        <Field>
          <FieldLabel id={`${id}-gap`} className='text-xs'>
            Column gap: {gap} grid {gap === 1 ? 'step' : 'steps'}
          </FieldLabel>
          <Slider
            aria-labelledby={`${id}-gap`}
            min={COLUMN_GAP_STEPS.min}
            max={COLUMN_GAP_STEPS.max}
            step={1}
            value={[gap]}
            onValueChange={(v) => updateData({ columnGapSteps: columnGapSteps(Array.isArray(v) ? v[0] : v) })}
          />
        </Field>
      )}
    </div>
  )
}
