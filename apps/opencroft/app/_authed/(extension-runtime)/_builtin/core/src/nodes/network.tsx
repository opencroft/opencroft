import { icons, type React } from '@ext/host'
import { Input, Label } from '@ext/ui'

import { ResizableContainer } from './section'

export interface NetworkData {
  label: string
  color: string
  networkName: string
  driver: string
  external: boolean
}

const NETWORK_COLORS = [
  'oklch(0.6 0.18 200)',
  'oklch(0.6 0.18 150)',
  'oklch(0.6 0.18 280)',
  'oklch(0.6 0.18 30)',
  'oklch(0.6 0.18 60)',
]

export function NetworkNode({ id, data, selected }: { id: string; data: NetworkData; selected?: boolean }) {
  const color = data.color || NETWORK_COLORS[0]
  const parts = [data.label || data.networkName || 'Network']
  if (data.external) {
    parts.push('(external)')
  }
  if (data.driver) {
    parts.push(`[${data.driver}]`)
  }
  return <ResizableContainer id={id} selected={selected} color={color} icon={icons.Network} label={parts.join(' ')} />
}

export function NetworkInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: NetworkData
  updateData: (p: Partial<NetworkData>) => void
}) {
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Label</Label>
        <Input
          value={data.label ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ label: e.target.value })}
          className='h-7 text-xs'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Network Name</Label>
        <Input
          value={data.networkName ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ networkName: e.target.value })}
          className='h-7 text-xs'
          placeholder='my-network'
        />
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Driver</Label>
        <Input
          value={data.driver ?? ''}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ driver: e.target.value })}
          className='h-7 text-xs'
          placeholder='bridge'
        />
      </div>
      <label className='flex items-center gap-2 text-xs'>
        <input
          type='checkbox'
          checked={data.external ?? false}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ external: e.target.checked })}
        />
        External network
      </label>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Color</Label>
        <div className='flex gap-1'>
          {NETWORK_COLORS.map((c) => (
            <button
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
    </div>
  )
}
