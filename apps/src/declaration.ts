/**
 * Strict declaration parsing and structural value binding.
 * @module @deepseek-ai/dsh-app-cards/declaration
 */

import { z } from 'zod/v3'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { AppCardError } from './errors.ts'
import { expandPresets } from './presets.ts'
import {previewScenariosSchema} from './preview.ts'
import type { Binding, CardDeclaration, JsonValue, MachineId, OperationResult } from './types.ts'

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/u)
const text = z.string().min(1).refine(value => !value.includes('\0'), 'NUL is not allowed')
const positive = z.number().int().positive().max(2_147_483_647)
const json = z.custom<JsonValue>(isJsonValue, 'Expected lossless JSON')
const recordKey = z.string().refine(key => !forbiddenKeys.has(key), 'Prototype keys are not allowed')
const schema = z.unknown().transform((value): JsonSchemaNode => {
  assertSupportedJsonSchema(value)
  return value
})
const inputSchema = z.unknown().transform((value): ObjectJsonSchema => {
  assertObjectJsonSchema(value)
  return value
})

const binding: z.ZodType<Binding> = z.lazy(() => z.union([
  z.object({ literal: json }).strict(),
  z.object({ ref: text }).strict(),
  z.object({ object: z.record(recordKey, binding) }).strict(),
  z.object({ array: z.array(binding) }).strict(),
]))
const common = { inputSchema, timeoutMs: positive }
const program = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('argv'), executable: text, args: z.array(binding) }).strict(),
  z.object({ kind: z.literal('script'), interpreter: text, source: text, args: z.array(binding) }).strict(),
])
const operation = z.discriminatedUnion('kind', [
  z.object({
    ...common, kind: z.literal('exec'), effect: z.enum(['observe', 'change']), context: identifier,
    program, stdin: z.object({ encoding: z.enum(['text', 'json']), value: binding }).strict().optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), binding).optional(),
    output: z.object({ decode: z.enum(['text', 'json']), schema }).strict(),
    successExitCodes: z.array(z.number().int().min(0).max(255)).nonempty(),
    outputLimitBytes: positive,
  }).strict(),
  z.object({
    ...common, kind: z.literal('transform'), source: text, input: binding, outputSchema: schema,
  }).strict(),
  z.object({
    ...common, kind: z.literal('agent'), prompt: text, input: binding,
    completion: z.enum(['submitted', 'result']), allowedOperations: z.array(identifier), outputSchema: schema,
  }).strict(),
  z.object({
    ...common, kind: z.literal('flow'), steps: z.array(z.object({
      id: identifier, operation: identifier, after: z.array(identifier),
      runAfter: z.enum(['success', 'settled']), input: binding, when: binding.optional(),
      onError: z.enum(['stop', 'continue']),
    }).strict()).nonempty(),
    output: binding, outputSchema: schema, concurrency: positive,
  }).strict(),
])
const declarationSchema = z.object({
  monitoring: z.object({intervalMs: z.number().int().min(5000).max(3600000)}).strict().optional(),
  apiVersion: z.literal('dsh.app-cards/v1'), kind: z.literal('MachineAppCards'),
  machineId: z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).transform(value => value as MachineId),
  revision: z.number().int().nonnegative().safe(),
  apps: z.record(identifier, z.object({ name: text, description: z.string().optional() }).strict()),
  contexts: z.record(identifier, z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('host'), cwd: text }).strict(),
    z.object({ kind: z.literal('ssh'), pathId: text, cwd: text }).strict(),
  ])),
  data: z.record(recordKey, json), operations: z.record(identifier, operation),
  actions: z.record(identifier, z.object({
    appId: identifier, label: text, operation: identifier, input: binding,
    availability: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('always') }).strict(),
      z.object({ kind: z.literal('check'), checkId: identifier, source: text }).strict(),
    ]),
    invalidates: z.array(identifier),
  }).strict()),
  checks: z.record(identifier, z.object({
    appId: identifier, label: text, operation: identifier, input: binding,
    evaluate: z.object({ language: z.literal('jsonata'), source: text }).strict(),
    freshForMs: positive,
  }).strict()),
  ui: z.object({
    previewScenarios:previewScenariosSchema.optional(),
    a2uiVersion: z.literal('0.9.1'), catalogId: z.literal('urn:dsh:app-cards:catalog:1'),
    surfaces: z.array(z.object({
      id: identifier, appId: identifier, order: z.number().finite(),
      formInitial: z.record(recordKey, json),
      components: z.array(z.object({ id: identifier, component: text }).catchall(json)),
    }).strict()),
  }).strict(),
}).strict()

/** Describe declaration fields from the same schema used by admission.
 * @returns JSON Schema for primitive declarations; relation checks remain enforced by the parser.
 */
export function describeDeclaration(): JsonValue {
  return JSON.parse(JSON.stringify(zodToJsonSchema(declarationSchema, { target: 'jsonSchema7', effectStrategy: 'input' }))) as JsonValue
}

function fail(message: string): never {
  throw new AppCardError('DECLARATION_INVALID', message)
}

function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) {
    fail(`Binding reference ${JSON.stringify(pointer)} must be an absolute JSON pointer`)
  }
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
  if (parts.some(part => forbiddenKeys.has(part))) fail('Binding references cannot traverse prototype keys')
  if (!['input', 'data', 'steps'].includes(parts[0] ?? '')) fail('Binding reference must start with /input, /data or /steps')
  return parts
}

function references(value: Binding): string[][] {
  if ('ref' in value) return [pointerParts(value.ref)]
  if ('object' in value) return Object.values(value.object).flatMap(references)
  if ('array' in value) return value.array.flatMap(references)
  return []
}

function requireKey(values: Readonly<Record<string, unknown>>, key: string, subject: string): void {
  if (!Object.hasOwn(values, key)) fail(`${subject} references unknown entry ${key}`)
}

function unique(values: readonly string[], subject: string): void {
  if (new Set(values).size !== values.length) fail(`${subject} contains duplicate entries`)
}

function acyclic(edges: ReadonlyMap<string, readonly string[]>, subject: string): void {
  const settled = new Set<string>()
  const visiting = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(`${subject} contains a cycle at ${id}`)
    if (settled.has(id)) return
    visiting.add(id)
    for (const child of edges.get(id) ?? []) visit(child)
    visiting.delete(id)
    settled.add(id)
  }
  for (const id of edges.keys()) visit(id)
}

function validateBinding(value: Binding, declaration: CardDeclaration, steps?: ReadonlySet<string>): void {
  for (const parts of references(value)) {
    if (parts[0] === 'data') resolveBinding({ ref: `/${parts.map(part => part.replace(/~/gu, '~0').replace(/\//gu, '~1')).join('/')}` },
      { input: null, data: { ...declaration.data } })
    if (parts[0] === 'steps' && (steps === undefined || parts[1] === undefined || !steps.has(parts[1]))) {
      fail(`Binding references an unavailable flow step ${parts[1] ?? '(missing id)'}`)
    }
  }
}

/** Parse the supported schema subset and reject unknown fields, unresolved references and recursive execution graphs.
 * UI component semantics are validated separately by the publisher; authority fields never receive defaults.
 * @param value - untrusted declaration JSON.
 * @returns a detached declaration whose operation and dependency graphs are acyclic.
 */
export function parseDeclaration(value: unknown): CardDeclaration {
  if (!isJsonValue(value)) fail('Declaration must be lossless JSON')
  const declaration = declarationSchema.parse(expandPresets(value))
  const edges = new Map<string, readonly string[]>()
  for (const [id, item] of Object.entries(declaration.operations)) {
    const children = item.kind === 'flow' ? item.steps.map(step => step.operation)
      : item.kind === 'agent' ? item.allowedOperations : []
    for (const child of children) requireKey(declaration.operations, child, `Operation ${id}`)
    edges.set(id, children)
    if (item.kind === 'exec') {
      requireKey(declaration.contexts, item.context, `Operation ${id}`)
      for (const argument of item.program.args) validateBinding(argument, declaration)
      for (const entry of Object.values(item.env ?? {})) validateBinding(entry, declaration)
      if (item.stdin !== undefined) validateBinding(item.stdin.value, declaration)
    } else if (item.kind === 'flow') {
      unique(item.steps.map(step => step.id), `Flow ${id}`)
      const dependencies = new Map(item.steps.map(step => [step.id, step.after]))
      for (const step of item.steps) {
        unique(step.after, `Dependencies of ${id}/${step.id}`)
        for (const dependency of step.after) if (!dependencies.has(dependency)) fail(`Flow ${id} has unknown dependency ${dependency}`)
      }
      acyclic(dependencies, `Flow ${id}`)
      const ancestors = (stepId: string): Set<string> => {
        const result = new Set<string>()
        const pending = [...dependencies.get(stepId) ?? []]
        for (const dependency of pending) {
          if (result.has(dependency)) continue
          result.add(dependency)
          pending.push(...dependencies.get(dependency) ?? [])
        }
        return result
      }
      for (const step of item.steps) {
        validateBinding(step.input, declaration, ancestors(step.id))
        if (step.when !== undefined) validateBinding(step.when, declaration, ancestors(step.id))
      }
      validateBinding(item.output, declaration, new Set(dependencies.keys()))
    } else {
      validateBinding(item.input, declaration)
      if (item.kind === 'agent') unique(item.allowedOperations, `Agent ${id} allowedOperations`)
    }
  }
  acyclic(edges, 'Operation graph')
  for (const [id, action] of Object.entries(declaration.actions)) {
    requireKey(declaration.apps, action.appId, `Action ${id}`)
    requireKey(declaration.operations, action.operation, `Action ${id}`)
    validateBinding(action.input, declaration)
    for (const check of action.invalidates) requireKey(declaration.checks, check, `Action ${id}`)
    if (action.availability.kind === 'check') requireKey(declaration.checks, action.availability.checkId, `Action ${id}`)
  }
  for (const [id, check] of Object.entries(declaration.checks)) {
    requireKey(declaration.apps, check.appId, `Check ${id}`)
    requireKey(declaration.operations, check.operation, `Check ${id}`)
    validateBinding(check.input, declaration)
    if (!isObserving(declaration, check.operation)) fail(`Check ${id} reaches a change operation`)
    if (declaration.monitoring) {
      const hasAgent = (opId: string): boolean => {
        const op = declaration.operations[opId]
        return op?.kind === 'agent' || (op?.kind === 'flow' && op.steps.some(s => hasAgent(s.operation)))
      }
      if (hasAgent(check.operation)) fail('Periodic monitoring must not invoke an agent; use deterministic observing operations')
    }
  }
  unique(declaration.ui.surfaces.map(surface => surface.id), 'Surface ids')
  for (const surface of declaration.ui.surfaces) requireKey(declaration.apps, surface.appId, `Surface ${surface.id}`)
  return declaration
}

/** Resolve only structural bindings; missing values and prototype traversal reject without string interpolation.
 * @param value - literal, pointer, object or array binding.
 * @param scope - input, declaration data and settled flow results.
 * @returns the bound JSON value.
 */
export function resolveBinding(
  value: Binding,
  scope: { input: JsonValue; data: JsonValue; steps?: Readonly<Record<string, OperationResult>> },
): JsonValue {
  if ('literal' in value) return value.literal
  if ('array' in value) return value.array.map(item => resolveBinding(item, scope))
  if ('object' in value) {
    return Object.fromEntries(Object.entries(value.object).map(([key, item]) => {
      if (forbiddenKeys.has(key)) fail('Binding objects cannot contain prototype keys')
      return [key, resolveBinding(item, scope)]
    }))
  }
  let current: unknown = scope
  for (const part of pointerParts(value.ref)) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, part)
      || (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/u.test(part))) {
      throw new AppCardError('BINDING_MISSING', `Missing binding reference ${value.ref}`)
    }
    current = Reflect.get(current, part)
  }
  if (!isJsonValue(current)) throw new AppCardError('BINDING_INVALID', `Reference ${value.ref} does not contain JSON`)
  return json.parse(current)
}

/** Whether every reachable process effect is explicitly observational; recursion or unknown operations reject.
 * @param declaration - declaration being classified.
 * @param operationId - operation entry point.
 * @returns true for transforms and graphs containing only observing effects.
 */
export function isObserving(declaration: CardDeclaration, operationId: string): boolean {
  const visiting = new Set<string>()
  const visit = (id: string): boolean => {
    requireKey(declaration.operations, id, 'Observation')
    if (visiting.has(id)) fail(`Operation graph contains a cycle at ${id}`)
    const item = declaration.operations[id]
    if (item === undefined) fail(`Unknown operation ${id}`)
    visiting.add(id)
    let result: boolean
    switch (item.kind) {
      case 'exec': result = item.effect === 'observe'; break
      case 'transform': result = true; break
      case 'flow': result = item.steps.every(step => visit(step.operation)); break
      case 'agent': result = item.allowedOperations.every(visit); break
    }
    visiting.delete(id)
    return result
  }
  return visit(operationId)
}
