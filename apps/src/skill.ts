/** Packaged application-card authoring guidance. @module @deepseek-ai/dsh-app-cards/skill */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod/v3'

const PACKAGED_SKILLS = [
  {name:'app-cards-extensions',url:new URL('../skills/app-cards-extensions/SKILL.md',import.meta.url),resourceDirectory:new URL('../skills/app-cards-extensions/',import.meta.url)},
  {
    name: 'app-cards-authoring',
    url: new URL('../skills/app-cards-authoring/SKILL.md', import.meta.url),
    resourceDirectory: new URL('../skills/app-cards-authoring/', import.meta.url),
  },
] as const

/** Register authored guidance through the skill registry's reversible effects.
 * @param ctx - Host context with the declared skill service.
 */
export async function registerPackagedSkill(ctx: Context): Promise<void> {
  const skills = await Promise.all(PACKAGED_SKILLS.map(async skill => ({
    skill,
    registration: parseSkill(await readFile(skill.url, 'utf8'), skill.name),
  })))
  for (const { skill, registration } of skills) {
    ctx.skills.register({
      ...registration,
      source: 'bundled',
      provider: 'app-cards',
      path: fileURLToPath(skill.url),
      resourceBase: { kind: 'directory', path: fileURLToPath(skill.resourceDirectory) },
    })
  }
}

/** Parse packaged frontmatter; malformed authoring fails plugin activation.
 * @param source - Complete Markdown file.
 * @param expectedName - Name owned by the package's skill inventory.
 * @returns Metadata and body without YAML delimiters.
 */
export function parseSkill(source: string, expectedName: string): Pick<
  SkillRegistration, 'name' | 'description' | 'whenToUse' | 'invocation' | 'content' | 'metadata'
> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(source)
  if (match === null) throw new Error(`packaged ${expectedName} skill is missing YAML frontmatter`)
  const text = z.string().trim().min(1)
  const data = z.object({
    name: z.literal(expectedName),
    description: text,
    whenToUse: text.optional(),
    'user-invocable': z.boolean().default(true),
    'disable-model-invocation': z.boolean().default(false),
    metadata: z.record(z.unknown()).optional(),
  }).parse(parseYaml(match[1] ?? ''))
  return {
    name: data.name,
    description: data.description,
    ...(data.whenToUse === undefined ? {} : { whenToUse: data.whenToUse }),
    invocation: {
      modelInvocable: !data['disable-model-invocation'],
      userInvocable: data['user-invocable'],
    },
    content: match[2] ?? '',
    ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
  }
}
