import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseSkill } from '../src/skill.ts'

const name = 'app-cards-authoring'
const minimal = `name: ${name}\ndescription: App cards`
const document = (metadata: string, newline = '\n') => `---\n${metadata}\n---\n# Guidance\n`.replaceAll('\n', newline)

describe('packaged skill frontmatter', () => {
  it('loads folded routing metadata and keeps references out of the body', async () => {
    const root = new URL('../skills/app-cards-authoring/', import.meta.url)
    const source = await readFile(new URL('SKILL.md', root), 'utf8')
    const skill = parseSkill(source, name)
    expect(skill).toMatchObject({
      name,
      invocation: { modelInvocable: true, userInvocable: true },
    })
    expect(skill.description).toContain('定制 UI 卡片')
    expect(skill.whenToUse).toContain('应用状态')
    expect(skill.content).toMatch(/^\s*# Application cards/u)
    expect(skill.content).not.toContain('description:')
    expect(skill.content).not.toMatch(/Ubuntu|systemctl|```(?:json|sh|ini)/u)
    const lines = skill.content.trimEnd().split('\n').length
    expect(lines).toBeGreaterThanOrEqual(35)
    expect(lines).toBeLessThanOrEqual(90)
    expect(skill.description.length).toBeLessThan(200)
    const links = [...skill.content.matchAll(/\]\((references\/[^)]+)\)/gu)].map(match => match[1]!)
    expect(links).toEqual([
      'references/interactions.md',
      'references/visuals.md',
      'references/ui-design.md',
      'references/declaration.md', 'references/service-lifecycle.md',
      'references/systemd-example.md', 'references/service-card.md',
    ])
    for (const link of links) expect(await readFile(new URL(link, root), 'utf8')).toMatch(/^# /u)
    expect(skill.content).not.toContain('[Service]')
  })

  it('defaults optional invocation controls and handles CRLF', () => {
    expect(parseSkill(document(minimal, '\r\n'), name)).toEqual({
      name, description: 'App cards', content: '# Guidance\r\n',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })

  it('preserves explicit invocation controls and optional metadata', () => {
    expect(parseSkill(document(`${minimal}
whenToUse: Revise cards
user-invocable: false
disable-model-invocation: true
metadata:
  audience: authors`), name)).toMatchObject({
      whenToUse: 'Revise cards',
      invocation: { modelInvocable: false, userInvocable: false },
      metadata: { audience: 'authors' },
    })
  })

  it.each([
    ['missing delimiters', minimal],
    ['unclosed header', `---\n${minimal}`],
    ['invalid YAML', document('name: [')],
    ['scalar header', document('text')],
    ['null header', document('null')],
    ['array header', document('- name')],
    ['missing name', document('description: App cards')],
    ['different name', document('name: another-skill\ndescription: App cards')],
    ['missing description', document(`name: ${name}`)],
    ['blank description', document(`name: ${name}\ndescription: "  "`)],
    ['non-string description', document(`name: ${name}\ndescription: 5`)],
    ['blank whenToUse', document(`${minimal}\nwhenToUse: ""`)],
    ['non-string whenToUse', document(`${minimal}\nwhenToUse: []`)],
    ['quoted user control', document(`${minimal}\nuser-invocable: "true"`)],
    ['non-boolean model control', document(`${minimal}\ndisable-model-invocation: 1`)],
    ['array metadata', document(`${minimal}\nmetadata: []`)],
    ['null metadata', document(`${minimal}\nmetadata: null`)],
    ['scalar metadata', document(`${minimal}\nmetadata: false`)],
  ])('rejects %s instead of registering incomplete guidance', (_label, source) => {
    expect(() => parseSkill(source, name)).toThrow()
  })
})
