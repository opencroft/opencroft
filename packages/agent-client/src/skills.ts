import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SkillDef {
  name: string
  description: string
}

const SKILLS_DIR = join(process.cwd(), 'skills')

interface Frontmatter {
  data: Record<string, string>
  body: string
}

function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, body: raw }
  }
  const data: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':')
    if (separator === -1) {
      continue
    }
    data[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { data, body: match[2] }
}

interface SkillFile extends SkillDef {
  body: string
}

async function readSkillFile(file: string): Promise<SkillFile> {
  const { data, body } = parseFrontmatter(await readFile(join(SKILLS_DIR, file), 'utf8'))
  return {
    name: data.name ?? file.replace(/\.md$/, ''),
    description: data.description ?? '',
    body: body.trim(),
  }
}

async function readAllSkillFiles(): Promise<SkillFile[]> {
  const entries = await readdir(SKILLS_DIR).catch(() => [] as string[])
  const files = entries.filter((entry) => entry.endsWith('.md'))
  return Promise.all(files.map(readSkillFile))
}

export async function fileSkills(): Promise<SkillDef[]> {
  const skills = await readAllSkillFiles()
  return skills.map(({ name, description }) => ({ name, description }))
}

export async function fileSkillHandler(name: string): Promise<string> {
  const skills = await readAllSkillFiles()
  const found = skills.find((skill) => skill.name === name)
  return found ? found.body : `Unknown skill: ${name}`
}
