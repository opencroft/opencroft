'use client'

import { Save, Trash } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AddImportFooter } from 'ui/components/experimental/add-import-footer'
import { Button } from 'ui/components/ui/button'
import { Field, FieldLabel } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'
import { Flex } from 'ui/components/ui/layout/flex'
import { MenuLayout } from 'ui/components/ui/layout/menulayout'
import { ScrollContent, ScrollHeader, ScrollPage } from 'ui/components/ui/layout/scrollpage'
import { SidebarMenuButton } from 'ui/components/ui/sidebar'

import type { SkillRecord } from './server/runtime'
import { SkillEditor } from './skill-editor'

export type { SkillRecord }

export interface SkillsManagerProps {
  // The current skill catalog (the host loads this, e.g. via getSkills()).
  skills: SkillRecord[]
  onCreate: (input: { name: string; description?: string; content?: string }) => Promise<SkillRecord>
  onUpdate: (
    name: string,
    updates: { name?: string; description?: string; content?: string },
  ) => Promise<SkillRecord | null>
  onDelete: (name: string) => Promise<boolean>
}

// Parse a "normal skill" markdown file: YAML frontmatter (name/description) plus
// a markdown body. Files without frontmatter are treated as a bare body.
function parseSkillFile(raw: string): { name?: string; description?: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!match) return { body: raw }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, '')
  }
  return { name: fields.name, description: fields.description, body: match[2].replace(/^\s*\n/, '') }
}

// A two-pane manager for the agent's editable skill catalog: a list on the left,
// a name/description form + markdown editor on the right. Data-driven — the host
// supplies the skills and the create/update/delete callbacks.
export function SkillsManager({ skills: incoming, onCreate, onUpdate, onDelete }: SkillsManagerProps) {
  const [skills, setSkills] = useState<SkillRecord[]>(incoming)
  const [selected, setSelected] = useState<SkillRecord | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')

  // Re-seed (and auto-select the first skill) when the host supplies a new list,
  // e.g. once an async load resolves.
  useEffect(() => {
    setSkills(incoming)
    setSelected((current) => current ?? incoming[0] ?? null)
  }, [incoming])

  // Mirror the selected skill into the editable fields.
  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setDescription(selected.description)
    setContent(selected.content)
  }, [selected])

  async function handleSave() {
    if (!selected) return
    const result = await onUpdate(selected.name, {
      name: name.trim() || selected.name,
      description,
      content,
    })
    if (result) {
      setSelected(result)
      setSkills((prev) => prev.map((s) => (s.id === result.id ? result : s)))
      toast.success('Skill saved', { description: `Saved "${result.name}"` })
    } else {
      toast.error('Save failed', { description: 'That name may already be in use.' })
    }
  }

  async function handleDelete() {
    if (!selected) return
    if (await onDelete(selected.name)) {
      const remaining = skills.filter((s) => s.id !== selected.id)
      setSkills(remaining)
      if (remaining[0]) {
        setSelected(remaining[0])
      } else {
        setSelected(null)
        setDescription('')
        setContent('')
      }
      toast.success('Skill deleted')
    } else {
      toast.error('Delete failed')
    }
  }

  async function handleAdd(name: string) {
    const skill = await onCreate({ name })
    setSkills((prev) => [...prev, skill])
    setSelected(skill)
    toast.success('Skill created', { description: `Created "${name}"` })
  }

  async function handleImport(file: File) {
    try {
      const parsed = parseSkillFile(await file.text())
      const importedName = parsed.name || file.name.replace(/\.[^.]+$/, '')
      const skill = await onCreate({
        name: importedName,
        description: parsed.description,
        content: parsed.body,
      })
      setSkills((prev) => [...prev, skill])
      setSelected(skill)
      toast.success('Skill imported', { description: `Imported "${importedName}"` })
    } catch (error) {
      toast.error('Import failed', {
        description: error instanceof Error ? error.message : 'Failed to import',
      })
    }
  }

  return (
    <MenuLayout
      isOpened={!!selected}
      onClosed={() => setSelected(null)}
      menuFooter={<AddImportFooter onAdd={handleAdd} onImport={handleImport} accept='.md,.txt' />}
      menu={
        <Flex className='p-1 gap-1'>
          {skills.map((skill) => (
            <SidebarMenuButton key={skill.id} isActive={selected?.id === skill.id} onClick={() => setSelected(skill)}>
              {skill.name}
            </SidebarMenuButton>
          ))}
        </Flex>
      }
    >
      {selected ? (
        <ScrollPage>
          <ScrollHeader>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Skill name'
              className='flex-1 border-0 bg-transparent px-0 text-2xl font-semibold shadow-none focus-visible:ring-0 md:text-2xl'
            />
            <Button onClick={handleSave}>
              <Save className='h-4 w-4' />
              Save
            </Button>
            <Button onClick={handleDelete} variant='destructive'>
              <Trash className='h-4 w-4' />
              Delete
            </Button>
          </ScrollHeader>
          <ScrollContent className='p-3 gap-3'>
            <Field>
              <FieldLabel>Description</FieldLabel>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder='One-line summary shown to the agent in the skill catalog'
              />
            </Field>
            <Field className='flex-1 min-h-0'>
              <FieldLabel>Instructions</FieldLabel>
              <SkillEditor value={content} onChange={setContent} className='flex-1 min-h-100' />
            </Field>
          </ScrollContent>
        </ScrollPage>
      ) : (
        <div className='flex-1 flex items-center justify-center font-medium'>Select a skill to edit</div>
      )}
    </MenuLayout>
  )
}
