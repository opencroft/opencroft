import { Check, ChevronsUpDown, Download, PackageCheck, RefreshCw, Replace, TriangleAlert } from 'lucide-react'
import { type MouseEvent, useRef, useState } from 'react'

import { Button } from '../button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../command'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from 'ui/components/ui/empty'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { Spinner } from 'ui/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table'
import { cn } from 'cn'

export type UnknownTypeKind = 'node' | 'app' | 'handle'

/** One place an unknown type is used. */
export interface UnknownTypeUsage {
  /** What uses it: a node, an app instance, or the node or app declaring a handle. */
  label: string
  /** Where that is, e.g. the space and graph. */
  location: string
  /** The page it is on, when it has one. */
  href?: string
}

export interface UnknownTypeEntry {
  kind: UnknownTypeKind
  type: string
  usages: UnknownTypeUsage[]
  /** A registry listing the extension this type names. */
  install?: { extensionId: string; registryName: string }
}

/** A known type an unknown one of the same kind can be replaced with. */
export interface ReplacementType {
  kind: Exclude<UnknownTypeKind, 'handle'>
  type: string
  label: string
  extensionName: string
}

/** What a replace would do, shown under the row's choice. */
export interface ReplacementPlan {
  count: number
  /** Connections kept on a handle the new type does not declare; they show as stale. */
  staleEdges: Array<{ location: string; node: string; handle: string }>
}

/** One row's chosen replacement. */
export interface ReplacementChoice {
  entry: UnknownTypeEntry
  to: string
}

export interface UnknownTypesProps {
  types: UnknownTypeEntry[]
  replacements: ReplacementType[]
  /** Registries that could not be read: types they list are not offered for install. */
  unreachableRegistries?: string[]
  /** A scan is running. */
  scanning?: boolean
  /** The entry whose extension is being installed, as `unknownTypeKey` gives it. */
  installing?: string
  /** Install all is running. */
  installingAll?: boolean
  /** The entry being replaced, as `unknownTypeKey` gives it. */
  replacing?: string
  /** Replace all is running. */
  replacingAll?: boolean
  onRescan: () => void
  onInstall: (entry: UnknownTypeEntry) => void
  /** Install every extension the list offers. Several types can name one extension; it is installed once. */
  onInstallAll: (extensionIds: string[]) => void
  /** What replacing `entry` with `to` would do. Asked when a row's choice changes; a rejection is shown in the row. */
  onPlanReplace: (entry: UnknownTypeEntry, to: string) => Promise<ReplacementPlan>
  /** Replace every use of `entry` with `to`. */
  onReplace: (choice: ReplacementChoice) => void
  /** Replace every row that has a choice, each with its own. */
  onReplaceAll: (choices: ReplacementChoice[]) => void
  /**
   * A plain press on a usage link, so a client router can take the navigation
   * over. Without it the browser follows the link. A modified press (new tab,
   * new window) always stays with the browser.
   */
  onNavigate?: (href: string) => void
  className?: string
}

/** One key per unknown type: two kinds may use the same type string. */
export function unknownTypeKey(entry: Pick<UnknownTypeEntry, 'kind' | 'type'>): string {
  return `${entry.kind}:${entry.type}`
}

const KIND_LABEL: Record<UnknownTypeKind, string> = { node: 'Node', app: 'App', handle: 'Handle' }
const USE_NOUN: Record<UnknownTypeKind, [string, string]> = {
  node: ['node', 'nodes'],
  app: ['app instance', 'app instances'],
  handle: ['handle', 'handles'],
}
const USAGES_SHOWN = 3

function plural(count: number, [one, many]: [string, string]) {
  return `${count} ${count === 1 ? one : many}`
}

function opensElsewhere(event: MouseEvent) {
  return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function Usages({
  entry,
  onNavigate,
}: {
  entry: UnknownTypeEntry
  onNavigate?: (href: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? entry.usages : entry.usages.slice(0, USAGES_SHOWN)
  const hidden = entry.usages.length - shown.length

  function linkClick(href: string) {
    return (event: MouseEvent<HTMLAnchorElement>) => {
      if (!onNavigate || opensElsewhere(event)) {
        return
      }
      event.preventDefault()
      onNavigate(href)
    }
  }

  return (
    <div className='flex min-w-0 flex-col gap-1'>
      <span className='text-muted-foreground'>{plural(entry.usages.length, USE_NOUN[entry.kind])}</span>
      <ul className='flex min-w-0 flex-col gap-0.5'>
        {shown.map((usage, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: usages have no id, and two can share a label and a location
          <li key={index} className='min-w-0 truncate'>
            {usage.href ? (
              <a href={usage.href} onClick={linkClick(usage.href)} className='font-medium hover:underline'>
                {usage.label}
              </a>
            ) : (
              <span className='font-medium'>{usage.label}</span>
            )}
            <span className='text-muted-foreground'> · {usage.location}</span>
          </li>
        ))}
      </ul>
      {entry.usages.length > USAGES_SHOWN && (
        <button
          type='button'
          className='self-start text-xs text-muted-foreground hover:text-foreground hover:underline'
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show fewer' : `${hidden} more`}
        </button>
      )}
    </div>
  )
}

function ReplacementPicker({
  candidates,
  value,
  disabled,
  onChange,
}: {
  candidates: ReplacementType[]
  value: ReplacementType | null
  disabled?: boolean
  onChange: (value: ReplacementType) => void
}) {
  const [open, setOpen] = useState(false)
  const groups = [...new Set(candidates.map((candidate) => candidate.extensionName))]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type='button'
            size='sm'
            variant='outline'
            role='combobox'
            aria-expanded={open}
            className='w-56 justify-between font-normal'
          />
        }
      >
        <span className={cn('truncate', !value && 'text-muted-foreground')}>{value?.label ?? 'Replace with…'}</span>
        <ChevronsUpDown className='opacity-50' />
      </PopoverTrigger>
      <PopoverContent className='w-80 p-0' align='end'>
        <Command>
          <CommandInput placeholder='Search types…' />
          <CommandList>
            <CommandEmpty>No installed type matches.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group} heading={group}>
                {candidates
                  .filter((candidate) => candidate.extensionName === group)
                  .map((candidate) => (
                    <CommandItem
                      key={candidate.type}
                      value={`${candidate.type} ${candidate.label} ${group}`}
                      onSelect={() => {
                        onChange(candidate)
                        setOpen(false)
                      }}
                    >
                      <Check className={cn(value?.type === candidate.type ? 'opacity-100' : 'opacity-0')} />
                      <span className='truncate'>{candidate.label}</span>
                      <span className='ml-auto truncate font-mono text-xs text-muted-foreground'>{candidate.type}</span>
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

type PlanState = { status: 'loading' } | { status: 'ready'; plan: ReplacementPlan } | { status: 'failed'; error: string }

function PlanNote({ entry, to, state }: { entry: UnknownTypeEntry; to: ReplacementType; state?: PlanState }) {
  if (!state || state.status === 'loading') {
    return <span className='text-xs text-muted-foreground'>Counting uses…</span>
  }
  if (state.status === 'failed') {
    return <span className='text-xs text-destructive'>{state.error}</span>
  }
  const { plan } = state
  return (
    <div className='flex max-w-72 flex-col items-end gap-0.5 text-right text-xs'>
      <span className='text-muted-foreground'>Rewrites {plural(plan.count, USE_NOUN[entry.kind])}</span>
      {plan.staleEdges.length > 0 && (
        <span
          className='flex items-start gap-1 text-amber-700 dark:text-amber-400'
          title={plan.staleEdges.map((edge) => `${edge.node} ${edge.handle} · ${edge.location}`).join('\n')}
        >
          <TriangleAlert className='mt-0.5 size-3 shrink-0' />
          {plural(plan.staleEdges.length, ['connection stays on a handle', 'connections stay on handles'])}{' '}
          {to.label} does not declare
        </span>
      )}
    </div>
  )
}

export function UnknownTypes({
  types,
  replacements,
  unreachableRegistries,
  scanning,
  installing,
  installingAll,
  replacing,
  replacingAll,
  onRescan,
  onInstall,
  onInstallAll,
  onPlanReplace,
  onReplace,
  onReplaceAll,
  onNavigate,
  className,
}: UnknownTypesProps) {
  const [chosen, setChosen] = useState<Record<string, ReplacementType>>({})
  const [plans, setPlans] = useState<Record<string, PlanState>>({})
  // The newest plan request per row: an answer to an older choice is dropped.
  const latestPlan = useRef<Record<string, string>>({})

  const installable = [...new Set(types.flatMap((entry) => (entry.install ? [entry.install.extensionId] : [])))]
  const busyInstalling = installingAll || installing !== undefined
  const busyReplacing = replacingAll || replacing !== undefined
  const choices: ReplacementChoice[] = types.flatMap((entry) => {
    const to = !entry.install && chosen[unknownTypeKey(entry)]
    return to ? [{ entry, to: to.type }] : []
  })

  function choose(entry: UnknownTypeEntry, to: ReplacementType) {
    const key = unknownTypeKey(entry)
    setChosen((current) => ({ ...current, [key]: to }))
    setPlans((current) => ({ ...current, [key]: { status: 'loading' } }))
    latestPlan.current[key] = to.type
    const settle = (state: PlanState) => {
      if (latestPlan.current[key] === to.type) {
        setPlans((current) => ({ ...current, [key]: state }))
      }
    }
    onPlanReplace(entry, to.type).then(
      (plan) => settle({ status: 'ready', plan }),
      (error) => settle({ status: 'failed', error: errorText(error) }),
    )
  }

  const rescan = (
    <Button type='button' variant='outline' disabled={scanning} onClick={onRescan}>
      {scanning ? <Spinner /> : <RefreshCw />} Rescan
    </Button>
  )

  const unreachable =
    unreachableRegistries && unreachableRegistries.length > 0 ? (
      <p className='flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm'>
        <TriangleAlert className='mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400' />
        <span>
          Could not read {unreachableRegistries.join(', ')}. Extensions listed there are not offered for install
          until {unreachableRegistries.length === 1 ? 'it can' : 'they can'} be read.
        </span>
      </p>
    ) : null

  if (types.length === 0) {
    return (
      <div className={cn('flex flex-1 flex-col gap-4', className)}>
        {unreachable}
        <Empty className='flex-1'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <PackageCheck />
            </EmptyMedia>
            <EmptyTitle>No unknown types</EmptyTitle>
            <EmptyDescription>
              Every node, app and handle type in use is provided by an installed extension.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{rescan}</EmptyContent>
        </Empty>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <p className='text-sm text-muted-foreground'>
          {plural(types.length, ['type', 'types'])} in use that no installed extension provides
        </p>
        <div className='flex flex-wrap items-center gap-2'>
          {rescan}
          {choices.length > 0 && (
            <Button
              type='button'
              variant='outline'
              disabled={busyReplacing}
              title={choices.map((choice) => `${choice.entry.type} → ${choice.to}`).join('\n')}
              onClick={() => onReplaceAll(choices)}
            >
              {replacingAll ? <Spinner /> : <Replace />} Replace all ({choices.length})
            </Button>
          )}
          {installable.length > 0 && (
            <Button
              type='button'
              disabled={busyInstalling}
              title={`Install ${plural(installable.length, ['extension', 'extensions'])}: ${installable.join(', ')}`}
              onClick={() => onInstallAll(installable)}
            >
              {installingAll ? <Spinner /> : <Download />} Install all ({installable.length})
            </Button>
          )}
        </div>
      </div>

      {unreachable}

      <div className='rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead className='hidden sm:table-cell'>Kind</TableHead>
              <TableHead>Used by</TableHead>
              <TableHead className='text-right'>
                <span className='sr-only'>Fix</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.map((entry) => {
              const key = unknownTypeKey(entry)
              const to = chosen[key] ?? null
              const isReplacing = replacing === key || (replacingAll === true && to !== null)
              return (
                <TableRow key={key} className='align-top'>
                  <TableCell className='max-w-56 whitespace-normal'>
                    <span className='font-mono text-xs break-all'>{entry.type}</span>
                    <span className='block text-xs text-muted-foreground sm:hidden'>{KIND_LABEL[entry.kind]}</span>
                  </TableCell>
                  <TableCell className='hidden text-muted-foreground sm:table-cell'>{KIND_LABEL[entry.kind]}</TableCell>
                  <TableCell className='max-w-72 whitespace-normal'>
                    <Usages entry={entry} onNavigate={onNavigate} />
                  </TableCell>
                  <TableCell className='text-right'>
                    {entry.install ? (
                      <div className='flex flex-col items-end gap-1'>
                        <Button
                          type='button'
                          size='sm'
                          disabled={busyInstalling}
                          onClick={() => onInstall(entry)}
                        >
                          {installing === key ? <Spinner /> : <Download />} Install
                        </Button>
                        <span className='text-xs text-muted-foreground'>
                          {entry.install.extensionId} from {entry.install.registryName}
                        </span>
                      </div>
                    ) : entry.kind === 'handle' ? (
                      <span className='text-xs text-muted-foreground'>No registry lists its extension</span>
                    ) : (
                      <div className='flex flex-col items-end gap-1'>
                        <div className='flex items-center gap-2'>
                          <ReplacementPicker
                            candidates={replacements.filter((candidate) => candidate.kind === entry.kind)}
                            value={to}
                            disabled={isReplacing}
                            onChange={(next) => choose(entry, next)}
                          />
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            disabled={!to || busyReplacing}
                            onClick={() => to && onReplace({ entry, to: to.type })}
                          >
                            {isReplacing ? <Spinner /> : <Replace />} Replace
                          </Button>
                        </div>
                        {to && <PlanNote entry={entry} to={to} state={plans[key]} />}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
