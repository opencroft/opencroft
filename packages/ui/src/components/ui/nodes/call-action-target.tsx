import { RefreshCwIcon } from 'lucide-react'

import { Button } from '../button'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '../combobox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'

/** A node the Call Action can call, as the picker lists it. */
export interface CallActionNodeOption {
  id: string
  name: string
  /** Its type, as stored: nodes picked together are all of one. */
  type: string
  /** Its type's name, shown beside its own. */
  typeName: string
  /** The names of the subgraphs it is inside, outermost first; empty at the top level. */
  path: string[]
}

/** An app the Call Action can call, as the picker lists it. */
export interface CallActionAppOption {
  id: string
  /** `<space>.<slug>`, shown beside its name. */
  address: string
  name: string
}

/** One of the target's actions, as the action picker lists it. */
export interface CallActionActionOption {
  id: string
  label: string
  /** Why a graph may not call it: listed, disabled, with this beside it. */
  unavailable?: string
}

/** What the Call Action calls: nodes, in the order picked, or one app. */
export type CallActionTargetValue = { nodes: string[] } | { app: string }

export interface CallActionTargetProps {
  nodes: CallActionNodeOption[]
  apps: CallActionAppOption[]
  value?: CallActionTargetValue
  /** Told the target picked: an app replaces whatever was picked, a node adds to the nodes of its type. */
  onValueChange?: (value: CallActionTargetValue | undefined) => void
  /** The target's actions; empty until a target is picked. */
  actions: CallActionActionOption[]
  action?: string
  onActionChange?: (action: string) => void
  /** The action's parameters changed since they were taken: Refresh shows, and takes them again. */
  stale?: boolean
  onRefresh?: () => void
  /** Turns the pickers off while the host is still listing what they offer. */
  disabled?: boolean
}

// Flat, as a value on a card reads: compact, and at least 44 px tall where the
// pointer is a finger.
const FIELD = 'h-7 w-full border-0 bg-transparent px-2 text-xs shadow-none dark:hover:bg-input/30 pointer-coarse:h-11'
const ITEM = 'text-xs pointer-coarse:min-h-11'

const nodeKey = (id: string) => `node:${id}`
const appKey = (id: string) => `app:${id}`

function keysOf(value: CallActionTargetValue | undefined): string[] {
  if (!value) {
    return []
  }
  return 'app' in value ? [appKey(value.app)] : value.nodes.map(nodeKey)
}

/** The target the picked `keys` make, `added` being the one picked last. */
function targetOf(keys: string[], added: string | undefined): CallActionTargetValue | undefined {
  if (added?.startsWith('app:')) {
    return { app: added.slice(4) }
  }
  const nodes = keys.filter((key) => key.startsWith('node:')).map((key) => key.slice(5))
  return nodes.length > 0 ? { nodes } : undefined
}

/**
 * What a Call Action calls: its target and its action, as two pickers on its
 * card. The target picker searches the nodes and apps by name; the first node
 * picked sets the type the others must have.
 */
export function CallActionTarget({
  nodes,
  apps,
  value,
  onValueChange,
  actions,
  action,
  onActionChange,
  stale,
  onRefresh,
  disabled,
}: CallActionTargetProps) {
  const picked = keysOf(value)
  const pickedNodes = value && 'nodes' in value ? value.nodes : []
  const nodeOf = new Map(nodes.map((node) => [node.id, node]))
  const appOf = new Map(apps.map((app) => [app.id, app]))
  const pickedType = pickedNodes.length > 0 ? nodeOf.get(pickedNodes[0])?.type : undefined

  const labelOf = (key: string): string => {
    if (key.startsWith('app:')) {
      return appOf.get(key.slice(4))?.address ?? key.slice(4)
    }
    const node = nodeOf.get(key.slice(5))
    return node ? [...node.path, node.name].join(' › ') : key.slice(5)
  }
  const shown = picked.length > 0 ? picked.map(labelOf).join(', ') : 'Pick a target…'
  const items = [...nodes.map((node) => nodeKey(node.id)), ...apps.map((app) => appKey(app.id))]
  const actionLabel = (id: unknown) => actions.find((a) => a.id === id)?.label ?? String(id ?? '')

  return (
    <div className='flex min-w-0 flex-col'>
      <Combobox
        items={items}
        multiple
        value={picked}
        itemToStringLabel={labelOf}
        disabled={disabled}
        onValueChange={(next: string[]) => {
          const added = next.find((key) => !picked.includes(key))
          onValueChange?.(targetOf(added?.startsWith('app:') ? [added] : next.filter((k) => !k.startsWith('app:')), added))
        }}
      >
        <ComboboxTrigger aria-label='Target' className={`${FIELD} flex items-center justify-between gap-1 rounded-md text-left`}>
          <span className={picked.length > 0 ? 'truncate' : 'truncate text-muted-foreground'}>{shown}</span>
        </ComboboxTrigger>
        <ComboboxContent className='min-w-56'>
          <ComboboxInput placeholder='Search nodes and apps…' showTrigger={false} />
          <ComboboxEmpty>Nothing by that name.</ComboboxEmpty>
          <ComboboxList>
            {(key: string) => {
              const node = key.startsWith('node:') ? nodeOf.get(key.slice(5)) : undefined
              const app = key.startsWith('app:') ? appOf.get(key.slice(4)) : undefined
              const otherType = node !== undefined && pickedType !== undefined && node.type !== pickedType
              return (
                <ComboboxItem key={key} value={key} disabled={otherType} className={ITEM}>
                  <span className='flex min-w-0 flex-col'>
                    <span className='truncate'>{node ? node.name : (app?.name ?? key)}</span>
                    <span className='truncate text-[10px] text-muted-foreground'>
                      {node ? [node.typeName, ...node.path].join(' · ') : `App · ${app?.address ?? ''}`}
                    </span>
                  </span>
                </ComboboxItem>
              )
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <Select
        value={action ?? null}
        disabled={disabled || actions.length === 0}
        onValueChange={(next) => {
          if (typeof next === 'string') {
            onActionChange?.(next)
          }
        }}
      >
        <SelectTrigger size='sm' aria-label='Action' className={FIELD}>
          <SelectValue className='truncate' placeholder={actions.length === 0 ? 'No actions' : 'Pick an action…'}>
            {actionLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {actions.map((option) => (
            <SelectItem key={option.id} value={option.id} disabled={option.unavailable !== undefined} className={ITEM}>
              <span className='flex min-w-0 flex-col'>
                <span className='truncate'>{option.label}</span>
                {option.unavailable ? (
                  <span className='text-[10px] text-muted-foreground'>{option.unavailable}</span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {stale ? (
        <div className='flex items-center justify-between gap-1 px-2 text-[10px] text-muted-foreground'>
          <span>Its parameters changed.</span>
          <Button variant='ghost' size='xs' onClick={onRefresh} className='pointer-coarse:h-11'>
            <RefreshCwIcon />
            Refresh
          </Button>
        </div>
      ) : null}
    </div>
  )
}
