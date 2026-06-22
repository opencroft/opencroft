import { createFileRoute } from '@tanstack/react-router'

import { readSkills, type SkillConfig, writeSkills } from '@/app/(agent)/_server/skill-store'

// Global skill list, shared by all local agents and stored in the settings DB
// (not on disk). The agent client resolves the catalog per turn, so saved skills
// take effect on the next message without resuming live sessions.
export const Route = createFileRoute('/(agent)/api/acp/skills')({
  server: {
    handlers: {
      GET: async () => Response.json(await readSkills()),
      POST: async ({ request }) => {
        const skills = (await request.json()) as SkillConfig[]
        await writeSkills(skills)
        return Response.json({ ok: true })
      },
    },
  },
})
