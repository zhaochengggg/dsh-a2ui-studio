import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import MachineManagement from '../../machines/index.mjs'
import AppCards from '../src/index.ts'
import type { CardDeclaration, MachineId, RunRecord } from '../src/types.ts'

const execute = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

async function boot() {
  const directory = await mkdtemp(fileURLToPath(new URL('./fixtures/.host-', import.meta.url)))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const catalogPath = join(directory, 'catalog')
  await mkdir(join(catalogPath, 'machines','example-host'), { recursive: true })
  await writeFile(join(catalogPath,'machines','example-host','machine.json'),JSON.stringify({version:1,id:'example-host',name:'Example Host',purpose:'Isolated test machine',aliases:[],connections:[],archived:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}))
  await execute('git', ['init', '-q', catalogPath])
  await execute('git', ['-C', catalogPath, 'add', 'machines'])
  await execute('git', ['-C', catalogPath, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Test inventory'])
  vi.stubEnv('DSH_APP_CARDS_EXAMPLE_ROOT', directory)
  const configUrl = pathToFileURL(join(directory, 'cordis.yml'))
  await copyFile(new URL('./fixtures/host/cordis.yml', import.meta.url), configUrl)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  ctx.baseUrl = `${pathToFileURL(directory).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime], ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt], ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-skill', SkillRegistry], ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess],
    ['@deepseek-ai/dsh-user-questions', UserQuestions], ['dsh-control-studio/machines', MachineManagement],
    ['@deepseek-ai/dsh-app-cards', AppCards],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module: ${specifier}`)
      return modules.get(specifier)
    },
  // Loader tests substitute module acquisition; Node's private cache methods are not used by these entries.
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: configUrl.href } })
  await ctx.loader.await()
  const handle = await ctx.agents.create({
    sessionId: SessionId(randomUUID()), meta: { cwd: directory },
    agentOptions: { provider: 'fixture', model: 'fixture' },
  })
  const requests: AskUserQuestionRequest[] = []
  let approve = true
  ctx.on('user-questions/request', async (request) => {
    requests.push(request)
    const question = request.questions[0]
    if (question === undefined) throw new Error('Expected one review')
    return { answers: [{ id: question.id, selected: [approve ? question.options?.[0]?.label ?? '' : '不发布'] }] }
  })
  const call = async (name: string, args: unknown) => {
    const result = await ctx.tools.execute({
      callId: ToolCallId(randomUUID()), name, arguments: args,
      agent: handle.agent, signal: new AbortController().signal,
    })
    if (result.isError) throw new Error(result.error.message)
    const text = result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
    return JSON.parse(text) as Record<string, unknown>
  }
  const declaration = JSON.parse(await readFile(new URL('../examples/minimal.json', import.meta.url), 'utf8')) as CardDeclaration
  const candidate: CardDeclaration = { ...declaration, contexts: { local: { kind: 'host', cwd: directory } } }
  return { ctx, directory, candidate, requests, call, handle, decline: () => { approve = false } }
}

class ScriptedAdapter extends LlmAdapter {
  private at = 0
  constructor(private readonly responses: ((options: GenerateOptions) => StreamChunk[])[]) { super() }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const response = this.responses[this.at++]
    if (response === undefined) throw new Error('Unexpected extra model request')
    for (const chunk of response(options)) yield chunk
  }
}

function toolResponse(id: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(id)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: JSON.stringify(args) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

async function settled(ctx: Context, receipt: RunRecord): Promise<RunRecord> {
  await expect.poll(() => ctx.appCards.readRun(receipt.id).state).not.toMatch(/^(queued|running)$/u)
  return ctx.appCards.readRun(receipt.id)
}

describe('application cards through real Loader composition', () => {
  it('makes the packaged skill discoverable and unloads only its own contribution', async () => {
    const { ctx, handle } = await boot()
    expect(AppCards.inject).toContain('skills')
    const skills = handle.agent.ctx.get('skills')
    if (skills === undefined) throw new Error('Session has no skill registry')
    const summaries = await skills.list()
    expect(summaries).toContainEqual(expect.objectContaining({
      name: 'app-cards-authoring', source: 'bundled', provider: 'app-cards',
      invocation: { modelInvocable: true, userInvocable: true },
    }))
    const skill = await skills.get('app-cards-authoring')
    expect(skill).toBeDefined()
    if (skill === undefined) throw new Error('Packaged app-card guidance was not registered')
    expect(skill.resourceBase).toEqual({
      kind: 'directory', path: fileURLToPath(new URL('../skills/app-cards-authoring/', import.meta.url)),
    })
    expect(renderSkillContent(skill)).toContain('<skill_content name="app-cards-authoring">')
    expect(renderSkillContent(skill)).toContain('references/service-card.md')
    expect(skill.content).not.toContain('name: app-cards-authoring')
    const entry = [...ctx.loader.entries()].find(item => item.options.name === '@deepseek-ai/dsh-app-cards')
    if (entry?.fiber === undefined) throw new Error('Expected app-cards Loader fiber')
    await entry.fiber.dispose()
    expect(await ctx.skills.get('app-cards-authoring')).toBeUndefined()
    expect(ctx.tools.schemas().some(tool => tool.name.startsWith('app_cards_'))).toBe(false)
  }, 30000)

  it('reuses unchanged execution approval but rejects stale requests and conflicting retry identities', async () => {
    const { ctx, candidate, call, requests } = await boot()
    const machineId = candidate.machineId
    const propose = (value: CardDeclaration, expectedRevision: number) => call('app_cards_propose', {
      declaration_json: JSON.stringify(value), expected_revision: expectedRevision, ask_ref: 'Update application view',
    })
    const first = await propose(candidate, 0)
    await call('app_cards_publish', { proposal_id: first['proposalId'] })
    const second = await propose({ ...candidate, revision: 2, apps: { example: { name: 'Updated view' } } }, 1)
    await call('app_cards_publish', { proposal_id: second['proposalId'] })
    expect(requests).toHaveLength(1)
    await expect(ctx.appCards.invoke(machineId, 1, 'say', {}, randomUUID())).rejects.toMatchObject({
      code: 'app-cards/rejected', details: { code: 'REVISION_CONFLICT' },
    })
    await expect(ctx.appCards.invoke(machineId, 2, 'missing', {}, randomUUID())).rejects.toMatchObject({
      code: 'app-cards/rejected', details: { code: 'ACTION_MISSING' },
    })
    const id = randomUUID()
    const receipt = await ctx.appCards.invoke(machineId, 2, 'say', {}, id)
    await settled(ctx, receipt)
    await expect(ctx.appCards.invoke(machineId, 2, 'say', { extra: true }, id)).rejects.toMatchObject({
      code: 'app-cards/rejected', details: { code: 'REQUEST_CONFLICT' },
    })
    await expect(call('app_cards_invoke', {
      machine_id: machineId, revision: 1, action_id: 'say', input_json: '{}', request_id: randomUUID(),
    })).rejects.toThrow('stale')
  }, 30000)

  it('refuses a second reviewed proposal after a competing publication commits', async () => {
    const { ctx, candidate, call } = await boot()
    const proposals = await Promise.all([1, 2].map(() => call('app_cards_propose', {
      declaration_json: JSON.stringify(candidate), expected_revision: 0, ask_ref: 'Concurrent review',
    })))
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let reviews = 0
    const off = ctx.on('user-questions/request', async (_request, next) => {
      if (++reviews === 1) { entered.resolve(undefined); await release.promise }
      return next()
    }, { prepend: true })
    const first = call('app_cards_publish', { proposal_id: proposals[0]!['proposalId'] })
    const refused = expect(first).rejects.toThrow('changed during review')
    try {
      await entered.promise
      await call('app_cards_publish', { proposal_id: proposals[1]!['proposalId'] })
      release.resolve(undefined)
      await refused
      expect((await ctx.appCards.read(candidate.machineId)).revision).toBe(1)
    } finally {
      release.resolve(undefined)
      await refused
      off()
    }
  }, 30000)

  it('hands a reviewed prompt to a scoped agent once and accepts only its explicit result', async () => {
    const { ctx, candidate, call } = await boot()
    const report = {
      ...candidate,
      operations: {
        ...candidate.operations,
        report: {
          kind: 'agent', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          timeoutMs: 5000, prompt: 'Summarize the supplied evidence.', input: { literal: {} },
          completion: 'result', allowedOperations: [],
          outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
        },
      },
      actions: {
        ...candidate.actions,
        report: {
          appId: 'example', label: '综合报告', operation: 'report', input: { literal: {} },
          availability: { kind: 'always' }, invalidates: [],
        },
      },
    }
    ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter([
      (options) => {
        const toolNames = options.tools?.map(tool => tool.name) ?? []
        expect(toolNames).toContain('app_result')
        expect(toolNames).not.toContain('app_cards_publish')
        return toolResponse('report-result', 'app_result', { result_json: '{"summary":"No remote health claims were made."}' })
      },
    ]))
    const pending = await call('app_cards_propose', {
      declaration_json: JSON.stringify(report), expected_revision: 0, ask_ref: 'Add a report task',
    })
    await call('app_cards_publish', { proposal_id: pending['proposalId'] })
    const receipt = await ctx.appCards.invoke('example-host' as MachineId, 1, 'report', {}, randomUUID())
    await expect.poll(() => ctx.appCards.readRun(receipt.id).submission).toBeDefined()
    const submission = ctx.appCards.readRun(receipt.id).submission
    if (submission === undefined) throw new Error('Missing prepared prompt')
    const agent = ctx.agents.get(SessionId(submission.sessionId))
    if (agent === undefined) throw new Error('Prepared agent is not live')
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: submission.text }], source: { kind: 'user' } }))
    }
    expect(await settled(ctx, receipt)).toMatchObject({
      state: 'succeeded', result: { value: { summary: 'No remote health claims were made.' } },
    })
    expect(ctx.appCards.readRun(receipt.id).submission).toBeUndefined()
    expect((await ctx.appCards.read('example-host' as MachineId)).checks).toEqual({})
  }, 30000)

  it('runs declaration and publication tools through the assembled agent', async () => {
    const { ctx, candidate, handle, requests } = await boot()
    ctx.llm.registerAdapter(['fixture'], new ScriptedAdapter([
      () => toolResponse('propose', 'app_cards_propose', {
        declaration_json: JSON.stringify(candidate), expected_revision: 0, ask_ref: 'Show application operations',
      }),
      (options) => {
        const result = options.messages.find(message => message.role === 'tool')
        if (!result) throw new Error('Missing proposal tool result')
        const text = result.content.find(block => block.type === 'text')
        if (text?.type !== 'text') throw new Error('Missing proposal result JSON')
        const proposal = JSON.parse(text.text) as { proposalId: string }
        return toolResponse('publish', 'app_cards_publish', { proposal_id: proposal.proposalId })
      },
      () => [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '已发布应用卡片；尚未执行检查。' },
        { type: 'block-end', index: 0, block: { type: 'text', text: '已发布应用卡片；尚未执行检查。' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]))
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Show application operations.' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    const calls = handle.agent.session.ownEvents().filter(event => event.type === 'tool/call')
      .map(event => event.data)
    expect(JSON.stringify(calls)).toContain('app_cards_propose')
    expect(JSON.stringify(calls)).toContain('app_cards_publish')
    expect(handle.agent.session.ownEvents().filter(event => event.type === 'tool/result')
      .every(event => event.data.message.isError === false)).toBe(true)
    expect(requests).toHaveLength(1)
    expect((await ctx.appCards.read('example-host' as MachineId)).checks).toEqual({})
    expect(handle.agent.session.ownEvents().flatMap(event => event.type === 'assistant/message'
      ? event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])).toMatchInlineSnapshot(`
        [
          "已发布应用卡片；尚未执行检查。",
        ]
      `)
  }, 30000)

  it('publishes one reviewed declaration, executes without reapproval, and refreshes evidence only on request', async () => {
    const { ctx, candidate, requests, call } = await boot()
    const machineId = 'example-host' as MachineId
    const events: string[] = []
    ctx.on('app-cards/changed', (event) => {
      events.push(event.kind)
    })
    const proposed = await call('app_cards_propose', {
      declaration_json: JSON.stringify(candidate), expected_revision: 0, ask_ref: 'Show application operations',
    })
    expect((await ctx.appCards.read(machineId)).declaration).toBeNull()
    await expect(ctx.appCards.invoke(machineId, 1, 'say', {}, randomUUID())).rejects.toMatchObject({
      code: 'app-cards/rejected', details: { code: 'DECLARATION_MISSING' },
    })
    expect(await call('app_cards_publish', { proposal_id: proposed['proposalId'] })).toEqual({ revision: 1 })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.questions[0]?.intent).toBeUndefined()
    expect(requests[0]?.questions[0]?.detail).toContain('执行摘要')
    expect((await ctx.appCards.read(machineId)).checks).toEqual({})
    const requestId = randomUUID()
    const receipt = await ctx.appCards.invoke(machineId, 1, 'say', {}, requestId)
    const result = await settled(ctx, receipt)
    expect(result).toMatchObject({ state: 'succeeded', result: { value: 'Application operation completed.' } })
    expect((await ctx.appCards.invoke(machineId, 1, 'say', {}, requestId)).id).toBe(receipt.id)
    expect((await ctx.appCards.read(machineId)).checks).toEqual({})
    const checks = await ctx.appCards.refresh(machineId, 1, randomUUID())
    expect(checks).toHaveLength(1)
    await settled(ctx, checks[0]!)
    await expect.poll(async () => (await ctx.appCards.read(machineId)).checks.available?.health).toBe('healthy')
    expect(requests).toHaveLength(1)
    expect(events).toContain('declaration')
    expect(events).toContain('observation')
    expect({
      published: (await ctx.appCards.read(machineId)).revision,
      action: result.state,
      actionValue: result.result?.value,
      health: (await ctx.appCards.read(machineId)).checks.available?.health,
      reviews: requests.length,
    }).toMatchInlineSnapshot(`
      {
        "action": "succeeded",
        "actionValue": "Application operation completed.",
        "health": "healthy",
        "published": 1,
        "reviews": 1,
      }
    `)
  }, 30000)

  it('never publishes a declined candidate and refuses unknown operations or stale versions', async () => {
    const { ctx, candidate, call, decline } = await boot()
    decline()
    const proposed = await call('app_cards_propose', {
      declaration_json: JSON.stringify(candidate), expected_revision: 0, ask_ref: 'Test declined publication',
    })
    await expect(call('app_cards_publish', { proposal_id: proposed['proposalId'] })).rejects.toThrow('not approved')
    expect((await ctx.appCards.read('example-host' as MachineId)).revision).toBe(0)
    await expect(call('app_cards_propose', {
      declaration_json: JSON.stringify({ ...candidate, operations: { unknown: { kind: 'arbitrary-code' } } }),
      expected_revision: 0, ask_ref: 'Invalid declaration',
    })).rejects.toThrow()
  }, 30000)
})
