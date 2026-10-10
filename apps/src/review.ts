/** Deterministic human-readable projection of the exact execution declaration. @module @deepseek-ai/dsh-app-cards/review */

import type { CardDeclaration, CardProposal, Operation, Binding, ExecutionReviewDocument } from './types.ts'
import { canonicalJson } from './digest.ts'
import { z } from 'zod/v3'

const reviewText = z.string().trim().min(1)
const reviewSchema = z.object({
  reviewId: reviewText,
  executionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  machine: z.object({ id: reviewText, name: reviewText }).strict(),
  fromRevision: z.number().int().nonnegative().safe(),
  toRevision: z.number().int().positive().safe(),
  contexts: z.array(z.object({
    id: reviewText, label: reviewText, kind: z.enum(['host', 'ssh']), cwd: reviewText,
  }).strict()),
  sections: z.array(z.object({
    id: reviewText, title: reviewText, summary: reviewText, body: reviewText,
    changed: z.boolean(), trigger: reviewText, effect: reviewText,
  }).strict()).min(1),
  documentation: reviewText.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.toRevision <= value.fromRevision) ctx.addIssue({ code: 'custom', message: 'Review revisions must increase' })
  for (const key of ['contexts', 'sections'] as const) {
    if (new Set(value[key].map(entry => entry.id)).size !== value[key].length) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'Review identifiers must be unique' })
    }
  }
})

/** Check review completeness independently of the generic user-question service.
 * @param value - review constructed from the frozen proposal.
 * @returns validated review; this does not grant execution authority.
 */
export function validateReview(value: unknown): ExecutionReviewDocument {
  return reviewSchema.parse(value)
}

/** Build one frozen review without running any declared operation.
 * @param proposal - validated candidate and resolved execution identities.
 * @param previous - previous declaration for highlighting changed entries.
 * @returns complete review content and a plain Markdown fallback.
 */
export function buildReview(
  proposal: CardProposal, previous: CardDeclaration | null,
): { document: ExecutionReviewDocument; detail: string } {
  const declaration = proposal.declaration
  const sections = Object.entries(declaration.operations).map(([id, operation]) => {
    const actions = Object.entries(declaration.actions).filter(([, action]) => action.operation === id)
    const checks = Object.entries(declaration.checks).filter(([, check]) => check.operation === id)
    const flows = Object.entries(declaration.operations)
      .filter(([, candidate]) => candidate.kind === 'flow' && candidate.steps.some(step => step.operation === id))
      .map(([name]) => name)
    const agents = Object.entries(declaration.operations)
      .filter(([, candidate]) => candidate.kind === 'agent' && candidate.allowedOperations.includes(id))
      .map(([name]) => name)
    const trigger = [
      ...checks.map(([name]) => `打开或手动刷新：${name}`),
      ...actions.map(([name]) => `用户动作：${name}`),
      ...flows.map(name => `流程 ${name} 的步骤`),
      ...agents.map(name => `允许 agent 任务 ${name} 调用`),
    ].join('；') || '没有直接入口'
    const context = operation.kind === 'exec' ? proposal.contexts[operation.context] : undefined
    const effect = operation.kind === 'exec'
      ? operation.effect === 'observe' ? '在目标执行；声明为观察用途，不代表已证明无副作用' : '变更操作'
      : operation.kind === 'transform' ? '纯数据处理'
        : operation.kind === 'agent' ? '交给 agent；仅可调用列出的操作' : '按所列依赖执行组合步骤'
    const changed = previous?.operations[id] === undefined
      || canonicalJson(previous.operations[id]) !== canonicalJson(operation)
    return {
      id, title: actions[0]?.[1].label ?? checks[0]?.[1].label ?? id,
      summary: `${operation.kind}${context === undefined ? '' : ` · ${context.display} · cwd ${context.cwd}`}`,
      trigger, effect, changed,
      body: [
        operationBody(operation, declaration),
        '### 输入参数及允许范围',
        inputTable(operation),
        fence(JSON.stringify(operation.inputSchema, null, 2), 'json'),
        '输入 schema 未限制的值仍然是开放输入；此处不会推测额外限制。',
        `最长执行时间：${operation.timeoutMs} ms；没有隐式重试。`,
        ...actions.map(([name, action]) => [
          `### 动作 ${name}`,
          `默认／表单输入绑定：\n${fence(JSON.stringify(action.input, null, 2), 'json')}`,
          `可用条件：\n${fence(JSON.stringify(action.availability, null, 2), 'json')}`,
          `接纳后失效的检查：${action.invalidates.join('、') || '无'}。操作成功不等于健康。`,
        ].join('\n\n')),
        ...checks.map(([name, check]) => [
          `### 打开／刷新检查 ${name}`,
          fence(JSON.stringify(check.input, null, 2), 'json'),
          '健康判定表达式：',
          fence(check.evaluate.source, 'jsonata'),
          `证据有效期：${check.freshForMs} ms。不会定时重跑。`,
        ].join('\n\n')),
      ].join('\n\n'),
    }
  })
  sections.push({
    id: '$static-data', title: '执行读取的静态数据', summary: '这些值随候选版本固定，变更会改变执行摘要',
    trigger: '声明绑定引用 /data 时', effect: '提供参数，不自动执行', changed: previous === null
      || canonicalJson(previous.data) !== canonicalJson(declaration.data),
    body: fence(JSON.stringify(declaration.data, null, 2), 'json'),
  })
  const document = validateReview({
    reviewId: proposal.id,
    executionDigest: proposal.executionDigest,
    machine: { id: declaration.machineId, name: declaration.machineId },
    fromRevision: proposal.expectedRevision,
    toRevision: declaration.revision,
    contexts: Object.entries(proposal.contexts).map(([id, context]) => ({
      id, label: context.display, kind: context.kind, cwd: context.cwd,
    })),
    sections,
    documentation: Object.values(declaration.apps).map(app => `${app.name}${app.description ? `：${app.description}` : ''}`).join('\n')
      || '此声明不包含应用说明。',
  })
  const detail = [
    `# 发布执行清单：${declaration.machineId}`,
    `版本 ${proposal.expectedRevision} → ${declaration.revision}`,
    `执行摘要：${proposal.executionDigest}`,
    '认可后，所列操作可在声明有效期间按其触发方式重复执行，不再逐次询问。此次发布本身不执行应用命令或检查。',
    ...document.contexts.map(context => `执行上下文 ${context.id}：${context.label}；cwd ${context.cwd}`),
    ...sections.map(section => `## ${section.title}\n\n${section.summary}\n\n${section.trigger}\n\n${section.effect}\n\n${section.body}`),
    '## 说明（不扩大授权范围）',
    fence(document.documentation ?? '无附加说明。', 'text'),
  ].join('\n\n')
  return { document, detail }
}

function inputTable(operation: Operation): string {
  const properties = Object.entries(operation.inputSchema.properties ?? {})
  if (properties.length === 0) return operation.inputSchema.additionalProperties === false
    ? '没有用户可变参数。' : '允许额外 JSON 字段；下方 schema 是完整约束。'
  return [
    '| 参数 | 类型 | 必填 | 允许值 | 默认值（注释，不自动填入） |',
    '| --- | --- | --- | --- | --- |',
    ...properties.map(([name, schema]) => {
      const values = schema.enum === undefined
        ? schema.const === undefined ? '此 schema 未列举取值范围' : JSON.stringify(schema.const)
        : JSON.stringify(schema.enum)
      return `| ${cell(name)} | ${cell(schema.type ?? (schema.oneOf ? 'oneOf，见完整约束' : 'JSON'))} | ${operation.inputSchema.required?.includes(name) ? '是' : '否'} | ${cell(values)} | ${cell(schema.default === undefined ? '无' : JSON.stringify(schema.default))} |`
    }),
  ].join('\n')
}

function cell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('\r', ' ')
}

function operationBody(operation: Operation, declaration: CardDeclaration): string {
  switch (operation.kind) {
    case 'exec': {
      const program = operation.program
      return [
        program.kind === 'argv'
          ? `### 具体命令\n\n${fence([quote(program.executable), ...program.args.map(arg => displayBinding(arg, declaration))].join(' '), 'sh')}`
          : `### 完整脚本\n\n解释器：${quote(program.interpreter)}\n\n${fence(program.source, 'sh')}`,
        '### 精确参数绑定',
        fence(JSON.stringify(program.args, null, 2), 'json'),
        `stdin：\n${fence(JSON.stringify(operation.stdin ?? null, null, 2), 'json')}`,
        `显式环境：\n${fence(JSON.stringify(operation.env ?? {}, null, 2), 'json')}`,
        '其余环境由 DSH 清理凭证形名称后提供；没有声明的凭证不会由卡片注入。',
        `有效退出码：${operation.successExitCodes.join('、')}；输出上限：${operation.outputLimitBytes} bytes。`,
        `输出解释：\n${fence(JSON.stringify(operation.output, null, 2), 'json')}`,
      ].join('\n\n')
    }
    case 'transform':
      return `### 纯转换表达式\n\n${fence(operation.source, 'jsonata')}\n\n输入：\n${fence(JSON.stringify(operation.input, null, 2), 'json')}\n\n输出：\n${fence(JSON.stringify(operation.outputSchema, null, 2), 'json')}`
    case 'agent':
      return [
        '### Agent 完整任务', fence(operation.prompt, 'text'),
        `完成语义：${operation.completion === 'submitted' ? '接纳即返回；不声称任务已完成' : '必须提交 schema 验证的结果'}。`,
        `可调用的操作：${operation.allowedOperations.join('、') || '无；仅处理输入数据'}。`,
        '### 任务输入', fence(JSON.stringify(operation.input, null, 2), 'json'),
        '### 输出要求', fence(JSON.stringify(operation.outputSchema, null, 2), 'json'),
      ].join('\n\n')
    case 'flow':
      return [
        `### 步骤依赖\n\n并发上限：${operation.concurrency}`,
        ...operation.steps.map(step => [
          `#### ${step.id} → ${step.operation}`,
          `依赖：${step.after.join('、') || '入口'}；${step.runAfter === 'success' ? '依赖成功后运行' : '依赖结束后运行（包括失败）'}；失败时${step.onError === 'stop' ? '停止' : '保留错误并继续'}。`,
          fence(JSON.stringify({ input: step.input, when: step.when ?? true }, null, 2), 'json'),
        ].join('\n\n')),
        '### 最终输出', fence(JSON.stringify({ output: operation.output, schema: operation.outputSchema }, null, 2), 'json'),
      ].join('\n\n')
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

function displayBinding(binding: Binding, declaration: CardDeclaration): string {
  if ('literal' in binding) return quote(typeof binding.literal === 'string' ? binding.literal : JSON.stringify(binding.literal))
  if ('ref' in binding && binding.ref.startsWith('/data/')) {
    const path = binding.ref.slice('/data/'.length).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    let value: unknown = declaration.data
    for (const key of path) {
      if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) return `<${binding.ref}>`
      value = Reflect.get(value, key) as unknown
    }
    return typeof value === 'string' ? quote(value) : `<${binding.ref}>`
  }
  return 'ref' in binding ? `<运行时参数 ${binding.ref}>` : '<结构化绑定，见精确参数>'
}

function fence(value: string, language: string): string {
  const length = Math.max(3, ...[...value.matchAll(/`+/gu)].map(match => match[0].length + 1))
  const marker = '`'.repeat(length)
  return `${marker}${language}\n${value}\n${marker}`
}
