import { NodeFrame, OutputHandle } from '@opencroft/client/canvas'
import { SecretValueField } from '@opencroft/client/secrets'
import { Input, Label } from '@opencroft/client/ui'
import { Lock, LockOpen, Route } from 'lucide-react'
import type { ChangeEvent } from 'react'

import { PATH_ERROR_SOURCE, routeUrlPath } from './api-route-path'
import {
  type ApiRouteProtectionData,
  DEFAULT_AUTH_HEADER,
  headerExample,
  headerNameError,
  protectionHeader,
  routeProtection,
} from './api-route-protection'
import { RunOutputRows } from './run-output-rows'
import { RUN_OUTPUTS } from './run-outputs'

export interface ApiRouteData extends ApiRouteProtectionData {
  path: string
  methods: string[]
}

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

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

export function ApiRouteNode({ data, selected }: { id: string; data: ApiRouteData; selected?: boolean }) {
  const path = data.path ?? '/'
  const methods = data.methods ?? ['GET']
  const protectedRoute = routeProtection(data) !== undefined

  return (
    <NodeFrame
      icon={Route}
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
          {protectedRoute ? (
            <span className='inline-flex items-center py-0.5 text-muted-foreground' title='Protected by a header'>
              <Lock className='size-3' aria-label='Protected' />
            </span>
          ) : null}
        </div>
      }
    >
      <RunOutputRows type='api-route' />
    </NodeFrame>
  )
}

// Whether the server stores a path error on the route: another route has its
// path (`api-route-claims.ts`). The field is marked by it, so the Errors tab
// always says why.
function hasPathError(data: ApiRouteData): boolean {
  const stored = (data as { __errors?: unknown }).__errors
  return (
    Array.isArray(stored) && stored.some((e) => typeof e === 'object' && e !== null && e.source === PATH_ERROR_SOURCE)
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
  const pathInvalid = hasPathError(data)

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
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ path: e.target.value })}
          placeholder='/users/:id'
          aria-invalid={pathInvalid ? true : undefined}
          className='font-mono'
        />
        <p className='text-[10px] text-muted-foreground'>
          {`Served at ${routeUrlPath(data.path)}. Use :param for path parameters (e.g., /users/:id). A path belongs to one route on this instance.`}
        </p>
      </div>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Methods</Label>
        <div className='flex flex-wrap gap-1'>
          {ALL_METHODS.map((m) => (
            <MethodBadge key={m} method={m} active={methods.includes(m)} onClick={() => toggleMethod(m)} />
          ))}
        </div>
      </div>
      <RouteAccessSection data={data} updateData={updateData} />
    </div>
  )
}

// The header a caller must send, and the value it must carry. The value is
// typed or a secret picked by name; the server resolves it per request.
function RouteAccessSection({
  data,
  updateData,
}: {
  data: ApiRouteData
  updateData: (p: Partial<ApiRouteData>) => void
}) {
  const header = protectionHeader(data)
  const protection = routeProtection(data)
  // Marked by the rule that makes it the node's error (`apiRouteDataProblems`),
  // so the Errors tab always says why the field is marked.
  const headerInvalid = headerNameError(data) !== undefined
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-col gap-1'>
        <Label className='text-xs'>Header</Label>
        <Input
          value={data.authHeader ?? ''}
          onChange={(e: ChangeEvent<HTMLInputElement>) => updateData({ authHeader: e.target.value })}
          placeholder={DEFAULT_AUTH_HEADER}
          aria-invalid={headerInvalid ? true : undefined}
          className='font-mono'
        />
        <p className='text-[10px] text-muted-foreground'>
          {`${DEFAULT_AUTH_HEADER} takes the value after Bearer; any other header, such as X-Api-Key, takes it as is.`}
        </p>
      </div>
      <SecretValueField
        label='Value'
        value={data.authToken}
        onChange={(authToken) => updateData({ authToken })}
        placeholder='Empty: the route is open'
      />
      {protection ? (
        <p className='flex items-start gap-1.5 text-xs'>
          <Lock className='mt-0.5 size-3 shrink-0' aria-hidden />
          <span>
            Protected. Requests without <code className='font-mono'>{headerExample(header)}</code> get 401.
          </span>
        </p>
      ) : (
        <p className='flex items-start gap-1.5 text-xs text-muted-foreground'>
          <LockOpen className='mt-0.5 size-3 shrink-0' aria-hidden />
          <span>Open. Anyone who can reach this instance can call this route. Set a value to require a header.</span>
        </p>
      )}
    </div>
  )
}

export const API_ROUTE_HANDLES = [
  { id: 'exec-out', handleType: 'execution-context', role: 'source' as const, label: 'Handler' },
  ...RUN_OUTPUTS['api-route'],
]

export function apiRouteExposeOutput(handleId: string, data: unknown): { path: string; methods: string[] } | undefined {
  if (handleId !== 'exec-out') {
    return undefined
  }
  const d = data as ApiRouteData
  return { path: d.path ?? '/', methods: d.methods ?? ['GET'] }
}
