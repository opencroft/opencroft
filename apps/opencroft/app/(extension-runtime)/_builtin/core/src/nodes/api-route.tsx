import { icons, NodeFrame, OutputHandle, React } from '@ext/host'
import { Input, Label } from '@ext/ui'

const { useMemo } = React

export interface ApiRouteData {
  path: string
  methods: string[]
}

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const METHOD_COLORS: Record<string, string> = {
  GET: 'text-green-400',
  POST: 'text-yellow-400',
  PUT: 'text-blue-400',
  PATCH: 'text-cyan-400',
  DELETE: 'text-red-400',
  HEAD: 'text-purple-400',
  OPTIONS: 'text-muted-foreground',
}

function MethodBadge({ method, active, onClick }: { method: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={
        'nodrag nopan inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ' +
        (active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted-foreground/10')
      }
    >
      {method}
    </button>
  )
}

export function ApiRouteNode({ id, data, selected }: { id: string; data: ApiRouteData; selected?: boolean }) {
  const path = data.path ?? '/'
  const methods = data.methods ?? ['GET']

  return (
    <NodeFrame
      icon={icons.Route}
      title={'API'}
      selected={selected ?? false}
      output={<OutputHandle type='execution-context' id='exec-out' />}
      extra={
        <div className='flex flex-wrap gap-1 align-baseline text-[10px] font-mono'>
          {methods.map((m) => (
            <span key={m} className='inline-flex px-1 py-0.5 font-medium bg-primary rounded text-primary-foreground'>
              {m}
            </span>
          ))}
          <span className='px-1 py-0.5 text-muted-foreground truncate'>{path}</span>
        </div>
      }
    />
  )
}

export function ApiRouteInspector({
  data,
  updateData,
}: {
  nodeId: string
  data: ApiRouteData
  updateData: (p: Partial<ApiRouteData>) => void
}) {
  const methods = data.methods ?? ['GET']

  const toggleMethod = (m: string) => {
    const next = methods.includes(m) ? methods.filter((x) => x !== m) : [...methods, m]
    if (next.length === 0) return
    updateData({ methods: next })
  }

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Route Path</Label>
        <Input
          value={data.path ?? '/'}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateData({ path: e.target.value })}
          placeholder='/users/:id'
          className='font-mono'
        />
        <p className='text-[10px] text-muted-foreground'>Use :param for path parameters (e.g., /users/:id)</p>
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Methods</Label>
        <div className='flex flex-wrap gap-1'>
          {ALL_METHODS.map((m) => (
            <MethodBadge key={m} method={m} active={methods.includes(m)} onClick={() => toggleMethod(m)} />
          ))}
        </div>
      </div>
    </div>
  )
}

export const API_ROUTE_HANDLES = [
  { id: 'exec-out', contextType: 'execution-context', role: 'source' as const, label: 'Handler' },
]

export function apiRouteExposeOutput(handleId: string, data: unknown): { path: string; methods: string[] } | undefined {
  if (handleId !== 'exec-out') {
    return undefined
  }
  const d = data as ApiRouteData
  return { path: d.path ?? '/', methods: d.methods ?? ['GET'] }
}
