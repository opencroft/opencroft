import {
  React,
  NodeResizer,
  icons,
  useReactFlow,
} from '@ext/host';
import {
  Input,
  Label,
} from '@ext/ui';

export interface SectionData {
  label: string;
  color: string;
}

const SECTION_COLORS = [
  'oklch(0.6 0.15 250)',
  'oklch(0.6 0.15 150)',
  'oklch(0.6 0.15 30)',
  'oklch(0.6 0.15 320)',
  'oklch(0.6 0.15 60)',
];

export function randomSectionColor(): string {
  return SECTION_COLORS[Math.floor(Math.random() * SECTION_COLORS.length)];
}

const SECTION_GRID = 10;
const snapSection = (v: number) => Math.round(v / SECTION_GRID) * SECTION_GRID;

export function ResizableContainer({
  id, selected, color, icon: Icon, label,
}: { id: string; selected?: boolean; color: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  const { setNodes } = useReactFlow();
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={200}
        minHeight={160}
        onResizeEnd={(_event, { width, height }) => {
          setNodes((nds) => nds.map((n) => (
            n.id === id
              ? { ...n, style: { ...n.style, width: snapSection(width), height: snapSection(height) } }
              : n
          )));
        }}
        lineStyle={{ border: '8px solid transparent', zIndex: 1 }}
        handleStyle={{ background: 'transparent', border: 'none', width: 16, height: 16, zIndex: 1 }}
      />
      <div
        className='h-full w-full rounded-lg p-3'
        style={{
          backgroundColor: `color-mix(in oklch, ${color} 8%, transparent)`,
          border: `1px dashed color-mix(in oklch, ${color} 40%, transparent)`,
        }}
      >
        <div className='flex items-center gap-1.5'>
          <Icon className='h-3.5 w-3.5' style={{ color }} />
          <span className='text-xs font-semibold' style={{ color }}>
            {label}
          </span>
        </div>
      </div>
    </>
  );
}

export function SectionNode({
  id, data, selected,
}: { id: string; data: SectionData; selected?: boolean }) {
  return (
    <ResizableContainer
      id={id}
      selected={selected}
      color={data.color || 'oklch(0.6 0.15 250)'}
      icon={icons.Boxes}
      label={data.label || 'Section'}
    />
  );
}

export function DomainNode({
  id, data, selected,
}: { id: string; data: SectionData; selected?: boolean }) {
  return (
    <ResizableContainer
      id={id}
      selected={selected}
      color={data.color || 'oklch(0.6 0.15 320)'}
      icon={icons.Globe}
      label={data.label || 'Domain'}
    />
  );
}

export function SectionInspector({
  data, updateData,
}: { nodeId: string; data: SectionData; updateData: (p: Partial<SectionData>) => void }) {
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
  );
}
