// A file's folder and name from templates in the one template syntax
// (`template.ts`), with the values a save knows. The save nodes of the Image and
// Audio Pipelines resolve them, on the server as they save and on the canvas for
// the field's live preview.

import { type FormatTemplateResult, formatTemplate } from './template'

/** A value a file-name template can name, for a field's hints and an agent's description. */
export interface FileNameToken {
  name: string
  description: string
}

/** What every save offers. A node adds what it knows of its own (an image's `width`). */
export const FILE_NAME_TOKENS: readonly FileNameToken[] = [
  { name: 'date', description: 'The date of the save, in UTC: 2026-10-30, or as formatted ({date:YYYYMMDD}).' },
  { name: 'time', description: 'The time of the save, in UTC: 14-05-09, or as formatted ({time:HHmm}).' },
  {
    name: 'counter',
    description: 'How many times this node has saved, this save included: 1, 2, …; {counter:04} gives 0001.',
  },
  { name: 'name', description: 'The node’s name.' },
  { name: 'size', description: 'The file’s size in bytes.' },
  { name: 'format', description: 'The file’s format, as its extension: png, wav.' },
]

/** `{date}` and `{time}` written without a format take these: no `:` or `/`, so the text fits in a name. */
export const FILE_NAME_DEFAULT_FORMATS: Readonly<Record<string, string>> = { date: 'YYYY-MM-DD', time: 'HH-mm-ss' }

/** What a save does when the name is taken: add a number (`photo-1.png`), replace the file, or fail. */
export const FILE_COLLISIONS = ['number', 'overwrite', 'fail'] as const

export type FileCollision = (typeof FILE_COLLISIONS)[number]

export const DEFAULT_FILE_COLLISION: FileCollision = 'number'

/** `value` when it is a collision rule, else the default. */
export function fileCollision(value: unknown): FileCollision {
  return FILE_COLLISIONS.find((c) => c === value) ?? DEFAULT_FILE_COLLISION
}

/**
 * The name `template` gives with `values`. Refused when it is empty, `.` or
 * `..`, or holds a `/` or a NUL, since then it would name something other than
 * one file in the folder.
 */
export function formatFileName(template: string, values: Readonly<Record<string, unknown>>): FormatTemplateResult {
  const result = formatTemplate(template, values, FILE_NAME_DEFAULT_FORMATS)
  if (!result.ok) {
    return result
  }
  if (result.text === '' || result.text === '.' || result.text === '..') {
    return { ok: false, error: result.text === '' ? 'The file name is empty' : `"${result.text}" is not a file name` }
  }
  if (result.text.includes('/')) {
    return { ok: false, error: `The file name "${result.text}" holds a "/"; put folders in the folder` }
  }
  if (result.text.includes('\0')) {
    return { ok: false, error: 'The file name holds a NUL character' }
  }
  return result
}

/**
 * The folder `template` gives with `values`: any path, `/` included. Empty is
 * the terminal's working directory. Refused when it holds a NUL.
 */
export function formatFolder(template: string, values: Readonly<Record<string, unknown>>): FormatTemplateResult {
  const result = formatTemplate(template, values, FILE_NAME_DEFAULT_FORMATS)
  if (result.ok && result.text.includes('\0')) {
    return { ok: false, error: 'The folder holds a NUL character' }
  }
  return result
}

/** `name` inside `folder`, which may be empty (the working directory) or end in `/`. */
export function joinFilePath(folder: string, name: string): string {
  if (folder === '') {
    return name
  }
  return folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`
}

/** `text` as a template that gives it back unchanged: its braces doubled. */
export function literalTemplate(text: string): string {
  return text.replace(/[{}]/g, (brace) => brace + brace)
}

/** Where a save node writes, as its data holds it: `folder`, `fileName` and `collision`. */
export interface FileSaveSettings {
  folder: string
  fileName: string
  collision: FileCollision
}

/**
 * A save node's settings from its data. A node whose data holds only `path`
 * writes that one file, overwriting it: it reads as that folder and name,
 * literally, with `overwrite`, until its fields are edited.
 */
export function fileSaveSettings(data: Readonly<Record<string, unknown>>): FileSaveSettings {
  const onlyPath = typeof data.path === 'string' ? data.path.trim() : ''
  if (typeof data.fileName !== 'string' && onlyPath) {
    const slash = onlyPath.lastIndexOf('/')
    return {
      folder: literalTemplate(slash === 0 ? '/' : onlyPath.slice(0, Math.max(slash, 0))),
      fileName: literalTemplate(onlyPath.slice(slash + 1)),
      collision: 'overwrite',
    }
  }
  return {
    folder: typeof data.folder === 'string' ? data.folder : '',
    fileName: typeof data.fileName === 'string' ? data.fileName : '',
    collision: fileCollision(data.collision),
  }
}

/** The `{counter}` of a save node's next save: one more than its `counter`, the saves it has made. */
export function nextSaveCount(data: Readonly<Record<string, unknown>>): number {
  const made = Math.floor(Number(data.counter))
  return (Number.isFinite(made) && made > 0 ? made : 0) + 1
}

/**
 * The full path a save writes to, before the collision rule: the folder and
 * name templates with `values`. `{ ok: false }` carries the first mistake,
 * the folder's before the name's.
 */
export function formatFilePath(
  folderTemplate: string,
  nameTemplate: string,
  values: Readonly<Record<string, unknown>>,
): FormatTemplateResult {
  const folder = formatFolder(folderTemplate, values)
  if (!folder.ok) {
    return { ok: false, error: `Folder: ${folder.error}` }
  }
  const name = formatFileName(nameTemplate, values)
  if (!name.ok) {
    return { ok: false, error: `Name: ${name.error}` }
  }
  return { ok: true, text: joinFilePath(folder.text, name.text) }
}
