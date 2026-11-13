import { BracesIcon, ChevronDownIcon, ChevronRightIcon, CornerLeftUpIcon, FolderIcon, FolderOpenIcon } from 'lucide-react'
import { type RefObject, useId, useRef, useState } from 'react'

import { Button } from '../button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../input-group'
import { Label } from '../label'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'

/** A value the templates can name: `{date}`, `{counter}`. */
export interface SaveFileToken {
  name: string
  description: string
}

/** What a save does when the name is taken: add a number to it, replace the file, or fail. */
export type SaveFileCollision = 'number' | 'overwrite' | 'fail'

const COLLISIONS: { value: SaveFileCollision; label: string; taken: string }[] = [
  { value: 'number', label: 'Add a number', taken: 'That name is taken: a number is added to it.' },
  { value: 'overwrite', label: 'Overwrite', taken: 'That name is taken: the file there is replaced.' },
  { value: 'fail', label: 'Fail', taken: 'That name is taken: the save will fail.' },
]

/**
 * What the next save writes: the path the templates give now, and whether a
 * file has that name already; or the first mistake in them.
 */
export type SaveFilePreview = { path: string; taken?: boolean } | { error: string }

/** A folder's subfolders, by name, with the folder's own path made absolute. */
export interface SaveFileFolderListing {
  path: string
  folders: string[]
}

export interface SaveFileFieldsProps {
  /** The folder template; empty saves in the working directory of the machine saved to. */
  folder: string
  /** The file name template. */
  name: string
  collision: SaveFileCollision
  /** Told every change as it is typed, inserted, picked or chosen. */
  onChange: (patch: { folder?: string; name?: string; collision?: SaveFileCollision }) => void
  /** What the Insert menus offer, in order. */
  tokens: SaveFileToken[]
  /** Shown under the fields; nothing while the host has none yet. */
  preview?: SaveFilePreview
  /**
   * Lists the folders in a path on the machine saved to; with it the folder
   * field offers Browse. A rejection's message is shown in the list.
   */
  listFolders?: (path: string) => Promise<SaveFileFolderListing>
  /** Placeholders of the two fields, as examples of a template. */
  folderPlaceholder?: string
  namePlaceholder?: string
}

// Compact in an inspector; at least 44 px tall where the pointer is a finger.
const FIELD = 'h-8 pointer-coarse:h-11'
const CONTROL = 'font-mono text-xs md:text-xs'
const ROW = 'min-h-8 pointer-coarse:min-h-11'

/** `value` with `insert` put in place of the selection of `input`, and the caret after it. */
function inserted(input: HTMLInputElement | null, value: string, insert: string): { text: string; caret: number } {
  const start = input?.selectionStart ?? value.length
  const end = input?.selectionEnd ?? start
  return { text: value.slice(0, start) + insert + value.slice(end), caret: start + insert.length }
}

/** The folder a template names before its first token: where Browse opens. */
function literalFolder(template: string): string {
  const brace = template.indexOf('{')
  const literal = brace === -1 ? template : template.slice(0, template.lastIndexOf('/', brace) + 1)
  return literal.length > 1 ? literal.replace(/\/$/, '') : literal
}

function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

function childOf(path: string, folder: string): string {
  return path.endsWith('/') ? `${path}${folder}` : `${path}/${folder}`
}

function InsertToken({
  label,
  tokens,
  inputRef,
  value,
  onInsert,
}: {
  label: string
  tokens: SaveFileToken[]
  inputRef: RefObject<HTMLInputElement | null>
  value: string
  onInsert: (value: string) => void
}) {
  const insert = (token: string) => {
    const input = inputRef.current
    const { text, caret } = inserted(input, value, `{${token}}`)
    onInsert(text)
    // After the menu has closed and handed focus back, and the new value has rendered.
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(caret, caret)
    })
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<InputGroupButton size='icon-xs' aria-label={label} className='pointer-coarse:size-9' />}
      >
        <BracesIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-64'>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Insert at the caret</DropdownMenuLabel>
          {tokens.map((token) => (
            <DropdownMenuItem
              key={token.name}
              onClick={() => insert(token.name)}
              className='flex-col items-start gap-0.5 pointer-coarse:min-h-11'
            >
              <span className='font-mono text-xs'>{`{${token.name}}`}</span>
              <span className='text-xs text-muted-foreground'>{token.description}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type Listing =
  | { state: 'loading'; path: string }
  | { state: 'ready'; listing: SaveFileFolderListing }
  | { state: 'error'; path: string; error: string }

function BrowseFolders({
  folder,
  listFolders,
  onPick,
}: {
  folder: string
  listFolders: (path: string) => Promise<SaveFileFolderListing>
  onPick: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<Listing>({ state: 'loading', path: '' })
  const latest = useRef(0)

  const show = (path: string) => {
    latest.current += 1
    const call = latest.current
    setListing({ state: 'loading', path })
    listFolders(path).then(
      (result) => call === latest.current && setListing({ state: 'ready', listing: result }),
      (err: unknown) =>
        call === latest.current &&
        setListing({ state: 'error', path, error: err instanceof Error ? err.message : String(err) }),
    )
  }

  const here = listing.state === 'ready' ? listing.listing.path : listing.path

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          show(literalFolder(folder))
        }
      }}
    >
      <PopoverTrigger
        render={<InputGroupButton size='icon-xs' aria-label='Browse folders' className='pointer-coarse:size-9' />}
      >
        <FolderOpenIcon />
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 gap-2 p-2'>
        <div className='flex items-center gap-1'>
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label='Up to the parent folder'
            disabled={listing.state !== 'ready' || here === '/'}
            onClick={() => show(parentOf(here))}
            className='pointer-coarse:size-11'
          >
            <CornerLeftUpIcon />
          </Button>
          <span className='min-w-0 flex-1 truncate font-mono text-xs' title={here}>
            {here || 'Working directory'}
          </span>
        </div>
        <div className='relative max-h-56 overflow-y-auto rounded-md border'>
          {listing.state === 'loading' && <p className='p-3 text-xs text-muted-foreground'>Listing folders…</p>}
          {listing.state === 'error' && <p className='p-3 text-xs text-destructive'>{listing.error}</p>}
          {listing.state === 'ready' && listing.listing.folders.length === 0 && (
            <p className='p-3 text-xs text-muted-foreground'>No folders in here.</p>
          )}
          {listing.state === 'ready' &&
            listing.listing.folders.map((name) => (
              <button
                key={name}
                type='button'
                onClick={() => show(childOf(listing.listing.path, name))}
                className={`flex w-full items-center gap-2 px-2 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none ${ROW}`}
              >
                <FolderIcon className='size-3.5 shrink-0 text-muted-foreground' />
                <span className='min-w-0 flex-1 truncate'>{name}</span>
                <ChevronRightIcon className='size-3.5 shrink-0 text-muted-foreground' />
              </button>
            ))}
        </div>
        <Button
          size='sm'
          disabled={listing.state !== 'ready'}
          onClick={() => {
            if (listing.state === 'ready') {
              onPick(listing.listing.path)
              setOpen(false)
            }
          }}
          className='pointer-coarse:h-11'
        >
          Use this folder
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function PreviewLine({ preview, collision }: { preview?: SaveFilePreview; collision: SaveFileCollision }) {
  if (!preview) {
    return null
  }
  if ('error' in preview) {
    return (
      <p role='status' className='rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive'>
        {preview.error}
      </p>
    )
  }
  const rule = COLLISIONS.find((c) => c.value === collision)
  return (
    <div role='status' className='flex flex-col gap-0.5 rounded-md bg-muted px-2 py-1.5 text-xs'>
      <span className='text-muted-foreground'>Next save</span>
      <span className='font-mono break-all'>{preview.path}</span>
      {preview.taken && rule && <span className='text-muted-foreground'>{rule.taken}</span>}
    </div>
  )
}

/**
 * Where a node saves a file. The folder and the name are templates in the
 * product's one template syntax (`{counter:04}`, `{date:YYYYMMDD}`); the host
 * resolves them and passes the result as `preview`, live as they change.
 */
export function SaveFileFields({
  folder,
  name,
  collision,
  onChange,
  tokens,
  preview,
  listFolders,
  folderPlaceholder,
  namePlaceholder,
}: SaveFileFieldsProps) {
  const folderRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const chosen = COLLISIONS.find((c) => c.value === collision) ?? COLLISIONS[0]
  const id = useId()

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-col gap-1'>
        <Label htmlFor={`${id}-folder`}>Folder</Label>
        <InputGroup className={FIELD}>
          <InputGroupInput
            id={`${id}-folder`}
            ref={folderRef}
            value={folder}
            placeholder={folderPlaceholder}
            spellCheck={false}
            onChange={(e) => onChange({ folder: e.target.value })}
            className={CONTROL}
          />
          <InputGroupAddon align='inline-end'>
            <InsertToken
              label='Insert a token into the folder'
              tokens={tokens}
              inputRef={folderRef}
              value={folder}
              onInsert={(next) => onChange({ folder: next })}
            />
            {listFolders && (
              <BrowseFolders folder={folder} listFolders={listFolders} onPick={(path) => onChange({ folder: path })} />
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div className='flex flex-col gap-1'>
        <Label htmlFor={`${id}-name`}>Name</Label>
        <InputGroup className={FIELD}>
          <InputGroupInput
            id={`${id}-name`}
            ref={nameRef}
            value={name}
            placeholder={namePlaceholder}
            spellCheck={false}
            onChange={(e) => onChange({ name: e.target.value })}
            className={CONTROL}
          />
          <InputGroupAddon align='inline-end'>
            <InsertToken
              label='Insert a token into the name'
              tokens={tokens}
              inputRef={nameRef}
              value={name}
              onInsert={(next) => onChange({ name: next })}
            />
          </InputGroupAddon>
        </InputGroup>
      </div>
      <div className='flex flex-col gap-1'>
        <Label id={`${id}-collision`}>If the name is taken</Label>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant='outline'
                size='sm'
                aria-labelledby={`${id}-collision`}
                className='w-full justify-between font-normal pointer-coarse:h-11'
              />
            }
          >
            {chosen.label}
            <ChevronDownIcon className='text-muted-foreground' />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={collision}
              onValueChange={(next) => {
                const rule = COLLISIONS.find((c) => c.value === next)
                if (rule) {
                  onChange({ collision: rule.value })
                }
              }}
            >
              {COLLISIONS.map((rule) => (
                <DropdownMenuRadioItem key={rule.value} value={rule.value} className='pointer-coarse:min-h-11'>
                  {rule.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <PreviewLine preview={preview} collision={collision} />
    </div>
  )
}
