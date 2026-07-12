import { readSkills, type SkillConfig, writeSkills } from '@/app/(agent)/_server/skill-store'
import { withApprovalRequired } from '@/app/(approvals)/_server/with-approval'

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>

function textResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text' as const, text }] }
}

function fail(code: number, message: string): never {
  throw { code, message }
}

export function formatSkillCatalog(skills: SkillConfig[]): string {
  return [...skills]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((skill) => `${skill.name}: ${skill.description}`)
    .join('\n')
}

export const skillToolDefinitions = [
  {
    name: 'skill_list',
    description: 'List available skills (name and description) for the skill tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'skill_write',
    description:
      'Create or overwrite a skill by name. Skills are shared by every local agent and loaded on demand when the agent invokes the skill tool.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique skill name — the key used for the upsert.' },
        description: { type: 'string', description: 'Shown in the skill catalog — when to use this skill.' },
        body: { type: 'string', description: 'Markdown instructions loaded when the agent invokes this skill.' },
      },
      required: ['name', 'description', 'body'],
    },
  },
  {
    name: 'skill_edit',
    description:
      "Replace an exact string in a skill's body. Fails if oldString is not unique unless replaceAll is true.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the skill to edit.' },
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The text to replace with.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['name', 'oldString', 'newString'],
    },
  },
  {
    name: 'skill_delete',
    description: 'Delete a skill by name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name of the skill to remove.' },
      },
      required: ['name'],
    },
  },
]

export const skillToolHandlers: Record<string, ToolHandler> = {
  skill_list: async () => {
    const skills = await readSkills()
    if (skills.length === 0) {
      return textResult('No skills configured yet.')
    }
    return textResult(formatSkillCatalog(skills))
  },

  skill_write: withApprovalRequired(
    async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const description = typeof args.description === 'string' ? args.description : ''
      const body = typeof args.body === 'string' ? args.body : ''
      if (!name || !description || !body) {
        fail(-32602, 'Missing required params: name, description, body')
      }
      const skills = await readSkills()
      const idx = skills.findIndex((skill) => skill.name === name)
      const config: SkillConfig = { name, description, body }
      if (idx >= 0) {
        skills[idx] = config
      } else {
        skills.push(config)
      }
      await writeSkills(skills)
      return textResult(`Skill "${name}" ${idx >= 0 ? 'updated' : 'created'}.`)
    },
    { view: 'skill_write' },
  ),

  skill_edit: withApprovalRequired(
    async (args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const oldString = args.oldString as string | undefined
      const newString = args.newString as string | undefined
      if (!name || oldString === undefined || newString === undefined) {
        fail(-32602, 'Missing required params: name, oldString, newString')
      }
      if (oldString === newString) {
        fail(-32602, 'oldString and newString must differ')
      }
      const replaceAll = Boolean(args.replaceAll)
      const skills = await readSkills()
      const idx = skills.findIndex((skill) => skill.name === name)
      if (idx === -1) {
        fail(-32602, `No skill named "${name}"`)
      }
      const body = skills[idx].body
      const occurrences = body.split(oldString).length - 1
      if (occurrences === 0) {
        fail(-32602, 'oldString not found in skill body')
      }
      if (occurrences > 1 && !replaceAll) {
        fail(-32602, `oldString is not unique (${occurrences} matches). Set replaceAll=true or provide more context.`)
      }
      const nextBody = replaceAll ? body.split(oldString).join(newString) : body.replace(oldString, newString)
      skills[idx] = { ...skills[idx], body: nextBody }
      await writeSkills(skills)
      return textResult(`Skill "${name}" updated.`)
    },
    { view: 'skill_edit' },
  ),

  skill_delete: withApprovalRequired(async (args) => {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) {
      fail(-32602, 'Missing required param: name')
    }
    const skills = await readSkills()
    const next = skills.filter((skill) => skill.name !== name)
    if (next.length === skills.length) {
      fail(-32602, `No skill named "${name}"`)
    }
    await writeSkills(next)
    return textResult(`Skill "${name}" removed.`)
  }),
}
