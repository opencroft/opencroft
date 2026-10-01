'use client'

import type { ExecutionMode } from '@opencroft/core'
import { Markdown } from 'agent-chat/components/markdown'
import {
  ArrowDownToLine,
  Cable,
  ChevronRight,
  ExternalLink,
  FileText,
  LayoutGrid,
  Loader2,
  Box as NodeIcon,
  Pencil,
  RefreshCw,
  Tag,
  Trash2,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Badge } from 'ui/badge'
import { Button } from 'ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'ui/collapsible'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from 'ui/item'
import { ScrollArea } from 'ui/layout/scroll-area'
import { PanelTabStrip } from 'ui/layouts/panel-tab-strip'
import { Separator } from 'ui/separator'

import type {
  InstalledExtensionRecord,
  UpdateCheck,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import type {
  LocalExtensionRecord,
  LocalRemoteState,
} from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'
import { isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'
import type {
  ExtensionHandle,
  ExtensionHandleType,
  ExtensionManifest,
  NodeMetadata,
} from '@/app/_authed/(extension-runtime)/_types'

export type ExtensionRecord = LocalExtensionRecord | InstalledExtensionRecord

/** An installed extension is a copy of a repository, described by the row that
 *  recorded its install; a local one is a checkout on this instance and carries
 *  git state instead. Which of the two is open decides what this page can say
 *  about its source, and — in the editor — whether the files it holds can be
 *  written back. Decided by the folder's owner, as the server decides it: an
 *  installed record's source is null when nothing recorded where it came from,
 *  so its presence cannot tell the two apart. */
export function isInstalledRecord(record: ExtensionRecord): record is InstalledExtensionRecord {
  return !isLocalFolder(record.folder)
}

/** What an extension contributes under `provides.apps`, its `type` qualified
 *  like every type the runtime has read. The runtime stores the rest of a
 *  provision opaquely, so this is read defensively rather than declared by the
 *  manifest type. */
interface ProvidedApp {
  type?: string
  title?: string
  description?: string
  parameters?: ProvidedAppParameter[]
  handles?: ProvidedAppHandle[]
  actions?: ProvidedAppAction[]
}

/** What an app is added with. */
interface ProvidedAppParameter {
  id?: string
  label?: string
  description?: string
  required?: boolean
}

/** What an app answers — the same shape an MCP caller sees. */
interface ProvidedAppAction {
  id?: string
  label?: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] }
  /** How a caller waits for it. Absent means `sync`. */
  execution?: ExecutionMode
}

/** What an app puts on the canvas. */
interface ProvidedAppHandle {
  id?: string
  label?: string
  handleType?: string
  dynamic?: boolean
}

function provided<T>(manifest: ExtensionManifest, key: string): T[] {
  const list = manifest.provides?.[key]
  return Array.isArray(list) ? (list.filter((entry) => typeof entry === 'object' && entry !== null) as T[]) : []
}

type TabId = 'description' | 'apps' | 'nodes' | 'handles' | 'version'

interface ExtensionDetailProps {
  record: ExtensionRecord
  /** For an installed extension: which tags the remote has. */
  updateCheck?: UpdateCheck
  /** For a local extension: where its checkout stands against origin. */
  remote?: LocalRemoteState | null
  remoteChecking?: boolean
  busy?: boolean
  onEdit: () => void
  onUpdate: () => void
  onDelete: () => void
}

/** One stated fact. The label column is fixed so a column of them reads down
 *  the values rather than down a ragged edge. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex min-w-0 items-baseline gap-3 text-sm'>
      <span className='w-28 shrink-0 text-xs text-muted-foreground'>{label}</span>
      <span className='min-w-0 flex-1 break-words'>{children}</span>
    </div>
  )
}

function Mono({ children }: { children: ReactNode }) {
  return <span className='font-mono text-xs'>{children}</span>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='flex flex-col gap-2'>
      <h2 className='text-xs font-medium tracking-wide text-muted-foreground uppercase'>{title}</h2>
      {children}
    </section>
  )
}

function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null
}

/** One group of what something declares — an app's parameters, actions or
 *  handles, a node's handles or actions — behind its own summary line.
 *
 *  Closed by default. The tab answers "what does this extension contribute"
 *  first, and one app here declares twenty-three actions with a paragraph
 *  each; opening them all by default would bury the second app below a screen
 *  of the first one's reference documentation. */
function DetailGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  if (count === 0) {
    return null
  }
  return (
    <Collapsible className='group/detailgroup border-t'>
      {/* The whole line is the toggle, not the chevron: a 14px glyph is a poor
          press target and the words beside it are a good one. */}
      <CollapsibleTrigger className='flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground'>
        <ChevronRight
          aria-hidden='true'
          className='size-3.5 shrink-0 transition-transform group-data-open/detailgroup:rotate-90'
        />
        {count} {label}
        {count === 1 ? '' : 's'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className='flex flex-col gap-2 px-4 pb-3'>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** An action's own parameters, read off its JSON schema: the names, with the
 *  optional ones marked. The schema itself is a tool's contract and belongs in
 *  the editor; what a reader of this page wants is what the action takes. */
function schemaParams(action: ProvidedAppAction): string[] {
  const properties = action.inputSchema?.properties
  if (!properties || typeof properties !== 'object') {
    return []
  }
  const required = Array.isArray(action.inputSchema?.required) ? action.inputSchema.required : []
  return Object.keys(properties).map((name) => (required.includes(name) ? name : `${name}?`))
}

/** The word an action's badge carries for how a caller waits for it.
 *
 *  Absent reads as Sync because that is what the contract says absent means
 *  (see ExecutionMode), so an action declared before modes existed is labelled
 *  as what it still is. A value that is none of the three is shown as written
 *  rather than as Sync: the manifest reaches this page unvalidated, and a
 *  misspelt mode wearing the default would look like a choice its author made. */
function executionLabel(execution: unknown): string {
  switch (execution ?? 'sync') {
    case 'sync':
      return 'Sync'
    case 'awaitable':
      return 'Awaitable'
    case 'async':
      return 'Async'
    default:
      return String(execution)
  }
}

function ExecutionBadge({ execution }: { execution: unknown }) {
  return <Badge variant='outline'>{executionLabel(execution)}</Badge>
}

function AppCard({ app }: { app: ProvidedApp }) {
  const parameters = app.parameters ?? []
  const actions = app.actions ?? []
  const handles = app.handles ?? []

  return (
    <div className='rounded-md border'>
      <div className='flex flex-col gap-1 px-4 py-3'>
        <div className='flex min-w-0 items-baseline gap-2'>
          <span className='text-sm font-medium'>{app.title ?? app.type}</span>
          {app.type ? <span className='truncate font-mono text-xs text-muted-foreground'>{app.type}</span> : null}
        </div>
        {app.description ? <p className='max-w-prose text-xs text-muted-foreground'>{app.description}</p> : null}
      </div>

      {/* Name first and the id after it in muted mono — the order the card's
          own heading reads in, and the one every row on this page now uses.
          The id is how a caller addresses the thing; the name is how a reader
          finds it, and a column of ids with the names trailing is a column
          sorted by the wrong half. */}
      <DetailGroup label='parameter' count={parameters.length}>
        {parameters.map((parameter) => (
          <div key={parameter.id ?? parameter.label} className='flex min-w-0 flex-col'>
            <span className='flex flex-wrap items-baseline gap-2 text-xs'>
              <span>{parameter.label ?? parameter.id}</span>
              {parameter.label && parameter.id ? (
                <span className='font-mono text-muted-foreground'>{parameter.id}</span>
              ) : null}
              {parameter.required ? <span className='text-amber-600'>required</span> : null}
            </span>
            {parameter.description ? (
              <span className='text-xs text-muted-foreground'>{parameter.description}</span>
            ) : null}
          </div>
        ))}
      </DetailGroup>

      <DetailGroup label='action' count={actions.length}>
        {actions.map((action) => {
          const params = schemaParams(action)
          return (
            <div key={action.id ?? action.label} className='flex min-w-0 flex-col'>
              <span className='flex flex-wrap items-baseline gap-2 text-xs'>
                <span>{action.label ?? action.id}</span>
                {action.label && action.id ? (
                  <span className='font-mono text-muted-foreground'>{action.id}</span>
                ) : null}
                {/* On every action, Sync included: an action that declares
                    nothing has still declared sync, and a row without a badge
                    would say less than the manifest does. */}
                <ExecutionBadge execution={action.execution} />
              </span>
              {params.length > 0 ? (
                <span className='font-mono text-xs text-muted-foreground'>({params.join(', ')})</span>
              ) : null}
              {action.description ? (
                <span className='max-w-prose text-xs text-muted-foreground'>{action.description}</span>
              ) : null}
            </div>
          )
        })}
      </DetailGroup>

      {/* Never behind a summary line, as on a node: an app declares one or
          two handles, and a press to reveal two rows saves nothing. They are
          all sources — an app consumes contexts through its parameters, not
          through edges — so there is no second column to put beside them. */}
      {handles.length > 0 ? (
        <div className='flex flex-col gap-1.5 border-t px-4 py-3'>
          <span className='text-xs font-medium'>Output</span>
          {handles.map((handle) => (
            <div key={handle.id ?? handle.label} className='flex min-w-0 flex-wrap items-baseline gap-2 text-xs'>
              {/* Type first, as in a node's handle columns: the same row means
                  the same thing on both screens. */}
              {handle.handleType ? (
                <Badge variant='outline' className='font-mono text-xs'>
                  {handle.handleType}
                </Badge>
              ) : null}
              {handle.label ? <span>{handle.label}</span> : null}
              <span className='font-mono text-muted-foreground'>{handle.id}</span>
              {handle.dynamic ? <span className='text-muted-foreground'>dynamic</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** One side of a node's edges: the handles it takes in, or the ones it hands
 *  on. The heading states the direction, so a row does not have to. */
function HandleColumn({ title, handles }: { title: string; handles: ExtensionHandle[] }) {
  return (
    <div className='flex min-w-0 flex-col gap-1.5'>
      <span className='text-xs font-medium'>{title}</span>
      {handles.length === 0 ? (
        <span className='text-xs text-muted-foreground'>None</span>
      ) : (
        handles.map((handle) => (
          <div key={handle.id} className='flex min-w-0 flex-wrap items-baseline gap-2 text-xs'>
            {/* The type leads the row. It is what decides whether two handles
                can be joined at all, so it is the thing a reader is scanning
                for; the name and the id say which one it is once the type
                already matches. */}
            <Badge variant='outline' className='font-mono text-xs'>
              {handle.handleType}
            </Badge>
            {handle.label ? <span>{handle.label}</span> : null}
            <span className='font-mono text-muted-foreground'>{handle.id}</span>
            {/* A prefix rather than an id: the node draws one of these per
                instance of whatever it is exposing, and the declared id is
                where each one starts. */}
            {handle.dynamic ? <span className='text-muted-foreground'>dynamic</span> : null}
          </div>
        ))
      )}
    </div>
  )
}

// Same card as an app's, for the same reason: a node's handles and actions are
// declared in the manifest, so a count of them is a fact the page is holding
// back rather than one it does not have.
function NodeCardList({ nodes }: { nodes: NodeMetadata[] }) {
  return (
    <div className='flex flex-col gap-3'>
      {nodes.map((node) => {
        const handles = node.handles ?? []
        const actions = node.actions ?? []
        return (
          <div key={node.type} className='rounded-md border'>
            <div className='flex flex-col gap-1 px-4 py-3'>
              <div className='flex min-w-0 items-baseline gap-2'>
                <span className='text-sm font-medium'>{node.name}</span>
                <span className='truncate font-mono text-xs text-muted-foreground'>{node.type}</span>
                {node.category ? (
                  <Badge variant='secondary' className='ml-auto shrink-0'>
                    {node.category}
                  </Badge>
                ) : null}
              </div>
              {node.description ? (
                <p className='max-w-prose text-xs text-muted-foreground'>{node.description}</p>
              ) : null}
            </div>

            {/* Two columns, because a node's handles are two different
                things: what it takes in and what it hands on. As one list
                each row had to carry its own direction, and reading "which of
                these can I connect to" meant scanning a word at the end of
                every line. Both columns are drawn whenever the node has any
                handle at all — a node with no inputs says so, which is worth
                knowing about a source.
 
                Not behind a summary line like the actions below: what a node
                connects to IS what a node is, and it is a handful of short
                rows. A group that costs a press only earns it by saving
                room. */}
            {handles.length > 0 ? (
              <div className='grid gap-4 border-t px-4 py-3 sm:grid-cols-2'>
                <HandleColumn title='Input' handles={handles.filter((handle) => handle.role === 'target')} />
                <HandleColumn title='Output' handles={handles.filter((handle) => handle.role === 'source')} />
              </div>
            ) : null}

            <DetailGroup label='action' count={actions.length}>
              {actions.map((action) => (
                <div key={action.id} className='flex min-w-0 flex-col'>
                  <span className='flex flex-wrap items-baseline gap-2 text-xs'>
                    <span>{action.label || action.id}</span>
                    {action.label ? <span className='font-mono text-muted-foreground'>{action.id}</span> : null}
                    <ExecutionBadge execution={action.execution} />
                  </span>
                  {action.description ? (
                    <span className='max-w-prose text-xs text-muted-foreground'>{action.description}</span>
                  ) : null}
                </div>
              ))}
            </DetailGroup>
          </div>
        )
      })}
    </div>
  )
}

function HandleTypeList({ handleTypes }: { handleTypes: ExtensionHandleType[] }) {
  return (
    <ItemGroup className='divide-y rounded-md border'>
      {handleTypes.map((handleType) => (
        <Item key={handleType.id} size='sm'>
          <span
            aria-hidden='true'
            className='mt-1.5 size-2.5 shrink-0 self-start rounded-full'
            style={{ background: handleType.color }}
          />
          <ItemContent>
            <ItemTitle>{handleType.label}</ItemTitle>
            <ItemDescription className='font-mono'>{handleType.id}</ItemDescription>
            {handleType.description ? <ItemDescription>{handleType.description}</ItemDescription> : null}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

/**
 * The extension's README, when it ships one.
 *
 * Read from the record's files rather than fetched: they are already here,
 * and this is the file an author writes when the manifest's one-line
 * description is not enough. Root level only, and `.md` or `.mdx` — a readme
 * inside a subdirectory documents that subdirectory.
 */
function readmeOf(files: Record<string, string>): string | null {
  const key = Object.keys(files).find((file) => /^readme\.mdx?$/i.test(file))
  const text = key ? files[key].trim() : ''
  return text.length > 0 ? text : null
}

// What the extension is, before anything is done to it: its identity, what it
// contributes to the product, and where its source stands. Editing, updating
// and deleting are offered from here rather than from the list, so a row press
// is navigation and an act is always made with the extension in front of you.
//
// Tabbed with the strip the node inspector uses, so a panel of sections here
// and a panel of sections there are navigated the same way. Only the tabs with
// something in them are drawn: an extension that publishes no nodes should not
// offer a Nodes tab that says "none".
export function ExtensionDetail({
  record,
  updateCheck,
  remote,
  remoteChecking = false,
  busy = false,
  onEdit,
  onUpdate,
  onDelete,
}: ExtensionDetailProps) {
  const [tab, setTab] = useState<TabId>('description')

  const installed = isInstalledRecord(record)
  // Where an installed extension came from, when anything recorded it. One that
  // was copied in by hand has no source, so there is nothing to update it from.
  const source = isInstalledRecord(record) ? record.source : null
  const manifest = record.manifest
  const nodes = manifest.nodes ?? []
  const handleTypes = manifest.handleTypes ?? []
  const apps = provided<ProvidedApp>(manifest, 'apps')
  const dependencies = manifest.extensionDependencies ?? []
  const readme = readmeOf(record.files)
  const hasUpdate = updateCheck?.hasUpdate ?? false
  // A local checkout is offered an update only when origin has a commit it
  // does not, and nothing is in the way of taking it.
  const canPull = !installed && (remote?.behind ?? false)

  const tabs = [
    { id: 'description', label: 'Description', icon: FileText },
    ...(apps.length > 0 ? [{ id: 'apps', label: 'Apps', icon: LayoutGrid, count: apps.length }] : []),
    ...(nodes.length > 0 ? [{ id: 'nodes', label: 'Nodes', icon: NodeIcon, count: nodes.length }] : []),
    ...(handleTypes.length > 0
      ? [{ id: 'handles', label: 'Handle Types', icon: Cable, count: handleTypes.length }]
      : []),
    { id: 'version', label: 'Version', icon: Tag },
  ]

  return (
    <div className='flex min-w-0 flex-1 flex-col'>
      <div className='flex shrink-0 items-start gap-3 border-b px-6 py-4'>
        <div className='flex min-w-0 flex-1 flex-col gap-1'>
          <div className='flex min-w-0 items-center gap-2'>
            <h1 className='truncate text-base font-semibold'>{manifest.name}</h1>
            <Badge variant='secondary' className='shrink-0 tabular-nums'>
              v{manifest.version}
            </Badge>
            {installed ? (
              <Badge variant='outline' className='shrink-0'>
                installed
              </Badge>
            ) : null}
          </div>
          <span className='truncate font-mono text-xs text-muted-foreground'>{record.id}</span>
        </div>

        <div className='flex shrink-0 items-center gap-1'>
          {source ? (
            <Button size='sm' variant='outline' disabled={busy} onClick={onUpdate}>
              {hasUpdate ? <ArrowDownToLine className='size-3.5' /> : <RefreshCw className='size-3.5' />}
              {hasUpdate ? `Update to ${updateCheck?.latest}` : 'Reinstall'}
            </Button>
          ) : null}
          {canPull ? (
            // Disabled rather than absent while something is in the way: the
            // update exists either way, and the reason it cannot be taken is
            // what the reader needs — it is on the button and under Version.
            <Button
              size='sm'
              variant='outline'
              disabled={busy || remote?.blocked !== null}
              title={remote?.blocked ?? undefined}
              onClick={onUpdate}
            >
              {busy ? <Loader2 className='size-3.5 animate-spin' /> : <ArrowDownToLine className='size-3.5' />}
              Update
            </Button>
          ) : null}
          <Button size='sm' onClick={onEdit}>
            <Pencil className='size-3.5' />
            Edit
          </Button>
          <Button
            size='sm'
            variant='ghost'
            className='text-muted-foreground hover:text-destructive'
            disabled={busy}
            onClick={onDelete}
          >
            {busy ? <Loader2 className='size-3.5 animate-spin' /> : <Trash2 className='size-3.5' />}
            {installed ? 'Uninstall' : 'Delete'}
          </Button>
        </div>
      </div>

      <PanelTabStrip tabs={tabs} activeId={tab} onSelect={(id) => setTab(id as TabId)} />

      <ScrollArea className='min-h-0 flex-1'>
        <div className='flex flex-col gap-6 px-6 py-5'>
          {tab === 'description' ? (
            <>
              {manifest.description ? <p className='max-w-prose text-sm'>{manifest.description}</p> : null}
              {!manifest.description && !readme ? (
                <p className='text-sm text-muted-foreground italic'>
                  This extension carries no description and no README.
                </p>
              ) : null}
              {dependencies.length > 0 ? (
                <div className='flex flex-col gap-1.5'>
                  <Field label='Depends on'>
                    <span className='flex flex-wrap gap-1'>
                      {dependencies.map((dep) => (
                        <Badge key={dep} variant='outline' className='font-mono text-xs'>
                          {dep}
                        </Badge>
                      ))}
                    </span>
                  </Field>
                </div>
              ) : null}
              {/* The README under the manifest's one line, with a rule between
                  them: the description is what the extension says it is in a
                  sentence, and this is the same author saying it at length.
                  Rendered with the chat's markdown component, so a document
                  here reads as the product's prose rather than as a second
                  treatment of markdown. */}
              {readme ? (
                <>
                  <Separator />
                  <Markdown text={readme} />
                </>
              ) : null}
            </>
          ) : null}

          {tab === 'apps' ? (
            <Section title={`Apps (${apps.length})`}>
              <div className='flex flex-col gap-3'>
                {apps.map((app) => (
                  <AppCard key={app.type ?? app.title} app={app} />
                ))}
              </div>
            </Section>
          ) : null}

          {tab === 'nodes' ? <NodeCardList nodes={nodes} /> : null}

          {tab === 'handles' ? (
            <>
              <p className='max-w-prose text-xs text-muted-foreground'>
                The types this extension's handles carry — what flows along an edge, in the sense a stream or a buffer
                is a type. Declared in the manifest as <Mono>handleTypes</Mono>.
              </p>
              <HandleTypeList handleTypes={handleTypes} />
            </>
          ) : null}

          {tab === 'version' ? (
            <>
              <div className='flex flex-col gap-1.5'>
                <Field label='Version'>
                  <Mono>{manifest.version}</Mono>
                </Field>
                {/* Named apart from the id under the title because the two differ
                    for a local copy standing in for another extension: the id is
                    what it runs as, the folder is where its files are. */}
                <Field label='Folder'>
                  <Mono>{record.folder}</Mono>
                </Field>
                {isInstalledRecord(record) ? (
                  <>
                    {source ? (
                      <>
                        <Field label='Repository'>
                          <a
                            href={source.url}
                            target='_blank'
                            rel='noreferrer'
                            className='inline-flex items-center gap-1 font-mono text-xs underline underline-offset-2'
                          >
                            {source.url}
                            <ExternalLink className='size-3' />
                          </a>
                        </Field>
                        <Field label='Installed ref'>
                          <Mono>{source.ref ?? 'unknown'}</Mono>
                        </Field>
                        {source.commit ? (
                          <Field label='Commit'>
                            <Mono>{shortCommit(source.commit)}</Mono>
                          </Field>
                        ) : null}
                        <Field label='Installed'>{new Date(source.installedAt).toLocaleString()}</Field>
                      </>
                    ) : (
                      <Field label='Repository'>
                        <span className='text-muted-foreground'>Not recorded</span>
                      </Field>
                    )}
                    <Field label='Updates'>
                      {hasUpdate ? (
                        <span className='text-amber-600'>{updateCheck?.latest} is available</span>
                      ) : updateCheck ? (
                        <span className='text-muted-foreground'>Up to date</span>
                      ) : (
                        <span className='text-muted-foreground'>Not checked</span>
                      )}
                    </Field>
                  </>
                ) : (
                  <>
                    <Field label='Checkout'>
                      {record.sourceCommit ? (
                        <span className='flex flex-wrap items-baseline gap-2'>
                          <Mono>
                            {record.branch ?? 'detached'} · {shortCommit(record.sourceCommit)}
                          </Mono>
                          {/* When that commit was made — the honest version of
                              the "Updated" this page used to print, which was
                              the extension directory's mtime and moved for
                              reasons that had nothing to do with the
                              extension changing. */}
                          {record.sourceCommitDate ? (
                            <span className='text-xs text-muted-foreground'>
                              committed {new Date(record.sourceCommitDate).toLocaleString()}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className='text-muted-foreground'>Not a git checkout</span>
                      )}
                    </Field>
                    {record.sourceCommit ? (
                      <Field label='Working tree'>
                        {record.sourceDirty ? (
                          <span className='flex flex-col gap-0.5'>
                            <span className='text-amber-600'>
                              {record.sourceDirtyPaths.length} uncommitted file
                              {record.sourceDirtyPaths.length === 1 ? '' : 's'}
                            </span>
                            {/* The files themselves, under the count rather
                                than inside a sentence: this is a list, and a
                                list of paths in prose is unreadable at three
                                and useless at ten. */}
                            {record.sourceDirtyPaths.map((dirtyPath) => (
                              <span key={dirtyPath} className='truncate font-mono text-xs text-muted-foreground'>
                                {dirtyPath}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className='text-muted-foreground'>Clean</span>
                        )}
                      </Field>
                    ) : null}
                    {record.sourceCommit ? (
                      <Field label='Updates'>
                        {remoteChecking ? (
                          <span className='flex items-center gap-1.5 text-muted-foreground'>
                            <Loader2 className='size-3 animate-spin' />
                            Checking origin…
                          </span>
                        ) : remote?.error ? (
                          <span className='text-muted-foreground'>{remote.error}</span>
                        ) : remote?.behind ? (
                          <span className='text-amber-600'>
                            origin/{remote.branch} has newer commits ({shortCommit(remote.remoteCommit)})
                          </span>
                        ) : remote ? (
                          <span className='text-muted-foreground'>Up to date with origin/{remote.branch}</span>
                        ) : (
                          <span className='text-muted-foreground'>Not checked</span>
                        )}
                      </Field>
                    ) : null}
                    {/* Why the update is not on offer, when there is one to
                        take. Said here as well as on the button, because the
                        button is the thing somebody presses and this is the
                        thing they read when it does not respond. */}
                    {remote?.behind && remote.blocked ? (
                      <Field label=''>
                        <span className='text-xs text-muted-foreground'>{remote.blocked}</span>
                      </Field>
                    ) : null}
                    <Field label='Running build'>
                      {record.builtCommit ? (
                        <Mono>
                          {shortCommit(record.builtCommit)}
                          {record.builtDirty ? ' (built with uncommitted changes)' : ''}
                        </Mono>
                      ) : (
                        <span className='text-muted-foreground'>Not built yet</span>
                      )}
                    </Field>
                  </>
                )}
              </div>

              {/* Why the running bundle is being held apart from the checkout.
                  Composed from the refusal's own reasons rather than printed
                  as its message: the message names the uncommitted files
                  inline, and they are listed above under the tree they belong
                  to. */}
              {!isInstalledRecord(record) && record.refusal ? (
                <div className='rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs'>
                  <p className='font-medium'>The automatic rebuild is refusing this checkout.</p>
                  <ul className='list-inside list-disc pt-0.5 text-muted-foreground'>
                    {record.refusal.reasons.map((reason) => (
                      <li key={reason}>
                        {reason === 'unclean'
                          ? 'It carries uncommitted changes.'
                          : `It is on branch "${record.refusal?.branch}", not the default branch "${record.refusal?.defaultBranch}".`}
                      </li>
                    ))}
                  </ul>
                  <p className='pt-1 text-muted-foreground'>
                    Compiling publishes this directory to the running instance as it stands, so the instance goes on
                    running the last build until the checkout is settled.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
