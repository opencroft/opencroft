'use client'

import { ArrowDownToLine, ExternalLink, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Badge } from 'ui/badge'
import { Button } from 'ui/button'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from 'ui/item'
import { ScrollArea } from 'ui/layout/scroll-area'

import type {
  InstalledExtensionRecord,
  UpdateCheck,
} from '@/app/_authed/(extension-editor)/_actions/installed-extensions-actions'
import type { LocalExtensionRecord } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions'

export type ExtensionRecord = LocalExtensionRecord | InstalledExtensionRecord

/** An installed extension carries a sidecar naming where it came from; a local
 *  one is a checkout on this instance and carries git state instead. Which of
 *  the two is open decides what this page can say about its source, and which
 *  destructive act it offers — delete removes a checkout, uninstall removes a
 *  copy of somebody else's repository. */
export function isInstalledRecord(record: ExtensionRecord): record is InstalledExtensionRecord {
  return 'sidecar' in record
}

interface ExtensionDetailProps {
  record: ExtensionRecord
  updateCheck?: UpdateCheck
  busy?: boolean
  onEdit: () => void
  onUpdate: () => void
  onDelete: () => void
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className='flex flex-col gap-2'>
      <h2 className='text-xs font-medium tracking-wide text-muted-foreground uppercase'>{title}</h2>
      {children}
    </section>
  )
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

function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null
}

// What the extension is, before anything is done to it: its identity, what it
// contributes to the product, and where its source stands. Editing and
// deleting are offered from here rather than from the list, so a row press is
// navigation and an act is always made with the extension in front of you.
export function ExtensionDetail({
  record,
  updateCheck,
  busy = false,
  onEdit,
  onUpdate,
  onDelete,
}: ExtensionDetailProps) {
  const installed = isInstalledRecord(record)
  const manifest = record.manifest
  const nodes = manifest.nodes ?? []
  const contexts = manifest.contexts ?? []
  const dependencies = manifest.extensionDependencies ?? []
  const provides = Object.entries(manifest.provides ?? {})
  const fileCount = Object.keys(record.files).length
  const hasUpdate = updateCheck?.hasUpdate ?? false

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
          {installed ? (
            <Button size='sm' variant='outline' disabled={busy} onClick={onUpdate}>
              {hasUpdate ? <ArrowDownToLine className='size-3.5' /> : <RefreshCw className='size-3.5' />}
              {hasUpdate ? `Update to ${updateCheck?.latest}` : 'Reinstall'}
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

      <ScrollArea className='min-h-0 flex-1'>
        <div className='flex flex-col gap-6 px-6 py-5'>
          {manifest.description ? <p className='max-w-prose text-sm'>{manifest.description}</p> : null}

          <Section title='Extension'>
            <div className='flex flex-col gap-1.5'>
              <Field label='Identifier'>
                <Mono>{manifest.id}</Mono>
              </Field>
              <Field label='Version'>
                <Mono>{manifest.version}</Mono>
              </Field>
              <Field label='Files'>{fileCount}</Field>
              <Field label='Updated'>{new Date(record.updatedAt).toLocaleString()}</Field>
              {dependencies.length > 0 ? (
                <Field label='Depends on'>
                  <span className='flex flex-wrap gap-1'>
                    {dependencies.map((dep) => (
                      <Badge key={dep} variant='outline' className='font-mono text-xs'>
                        {dep}
                      </Badge>
                    ))}
                  </span>
                </Field>
              ) : null}
              {provides.length > 0 ? (
                <Field label='Provides'>
                  <span className='flex flex-wrap gap-1'>
                    {provides.map(([key, values]) => (
                      <Badge key={key} variant='outline' className='font-mono text-xs'>
                        {key} · {Array.isArray(values) ? values.length : 0}
                      </Badge>
                    ))}
                  </span>
                </Field>
              ) : null}
            </div>
          </Section>

          {nodes.length > 0 ? (
            <Section title={`Nodes (${nodes.length})`}>
              <ItemGroup className='divide-y rounded-md border'>
                {nodes.map((node) => (
                  <Item key={node.typeId} size='sm'>
                    <ItemContent>
                      <ItemTitle>{node.name}</ItemTitle>
                      <ItemDescription className='font-mono'>{node.typeId}</ItemDescription>
                      {node.description ? <ItemDescription>{node.description}</ItemDescription> : null}
                    </ItemContent>
                    {node.category ? (
                      <Badge variant='secondary' className='shrink-0'>
                        {node.category}
                      </Badge>
                    ) : null}
                  </Item>
                ))}
              </ItemGroup>
            </Section>
          ) : null}

          {contexts.length > 0 ? (
            <Section title={`Context types (${contexts.length})`}>
              <div className='flex flex-wrap gap-1.5'>
                {contexts.map((context) => (
                  <span
                    key={context.id}
                    className='flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs'
                    title={context.description}
                  >
                    <span aria-hidden='true' className='size-2 rounded-full' style={{ background: context.color }} />
                    {context.label}
                    <span className='font-mono text-muted-foreground'>{context.id}</span>
                  </span>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title='Source'>
            {installed ? (
              <div className='flex flex-col gap-1.5'>
                <Field label='Repository'>
                  <a
                    href={record.sidecar.source.url}
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center gap-1 font-mono text-xs underline underline-offset-2'
                  >
                    {record.sidecar.source.url}
                    <ExternalLink className='size-3' />
                  </a>
                </Field>
                <Field label='Version'>
                  <Mono>{record.sidecar.ref}</Mono>
                </Field>
                <Field label='Installed'>{new Date(record.sidecar.installedAt).toLocaleString()}</Field>
                <Field label='Updates'>
                  {hasUpdate ? (
                    <span className='text-amber-600'>{updateCheck?.latest} is available</span>
                  ) : updateCheck ? (
                    <span className='text-muted-foreground'>Up to date</span>
                  ) : (
                    <span className='text-muted-foreground'>Not checked</span>
                  )}
                </Field>
              </div>
            ) : (
              <div className='flex flex-col gap-1.5'>
                <Field label='Checkout'>
                  {record.sourceCommit ? (
                    <Mono>
                      {record.branch ?? 'detached'} · {shortCommit(record.sourceCommit)}
                    </Mono>
                  ) : (
                    <span className='text-muted-foreground'>Not a git checkout</span>
                  )}
                </Field>
                {record.sourceCommit ? (
                  <Field label='Working tree'>
                    {record.sourceDirty ? (
                      <span className='text-amber-600'>
                        {record.sourceDirtyPaths.length} uncommitted file
                        {record.sourceDirtyPaths.length === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className='text-muted-foreground'>Clean</span>
                    )}
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
              </div>
            )}
          </Section>

          {/* Why the running bundle is being held apart from the checkout, in
              the compiler's own words. Stated on the page rather than only at
              the moment a build is refused: the extension goes on running the
              older bundle in the meantime, and that is the part a reader is
              otherwise left to infer. */}
          {!installed && record.refusal ? (
            <div className='rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs'>
              <p className='font-medium'>The automatic rebuild is refusing this checkout.</p>
              <p className='pt-0.5 text-muted-foreground'>{record.refusal.message}</p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
