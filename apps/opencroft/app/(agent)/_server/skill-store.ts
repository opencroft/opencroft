import type { SkillDef } from 'agent-client/skills'

import { getSetting, upsertSetting } from '@/server/data'

// Global skill list for local agents, stored in the settings table (the data
// volume) rather than on-disk skill markdown files — the same storage MCP
// servers use. Every local agent in the workspace shares this list.
const SETTING_ID = 'agent-skills'

export interface SkillConfig extends SkillDef {
  // The skill instructions loaded when the agent invokes the skill tool.
  body: string
}

export async function readSkills(): Promise<SkillConfig[]> {
  const row = await getSetting(SETTING_ID)
  if (!row) {
    return []
  }
  const parsed = JSON.parse(row.data) as { skills?: SkillConfig[] }
  return parsed.skills ?? []
}

export async function writeSkills(skills: SkillConfig[]): Promise<void> {
  await upsertSetting(SETTING_ID, JSON.stringify({ skills }))
}

// Skill catalog (name + description) handed to the agent client's skill tool.
export async function loadSkillDefs(): Promise<SkillDef[]> {
  return (await readSkills()).map(({ name, description }) => ({ name, description }))
}

// Resolve a skill body by name when the agent invokes the skill tool.
export async function skillBodyHandler(name: string): Promise<string> {
  const skill = (await readSkills()).find((entry) => entry.name === name)
  return skill ? skill.body : `Unknown skill: ${name}`
}
