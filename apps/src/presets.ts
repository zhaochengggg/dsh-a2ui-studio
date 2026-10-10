/**
 * Declaration shorthand expanded before validation, review and persistence.
 * @module @deepseek-ai/dsh-app-cards/presets
 */

import { z } from 'zod/v3'
import { AppCardError } from './errors.ts'

/** Expand command, script, probe, agent-task and inspection-report operation shorthand.
 * Command and script lift their program fields; probe fixes the effect to observe. Other fields remain explicit.
 * Agent-task and inspection-report are aliases for agent and flow, without service-specific behavior.
 * @param value - candidate declaration, before strict parsing.
 * @returns the candidate containing only primitive operations; unknown fields remain for strict rejection.
 */
export function expandPresets(value: unknown): unknown {
  const declaration = z.object({ operations: z.record(z.unknown()) }).passthrough().safeParse(value)
  if (!declaration.success) return value
  const operations = Object.fromEntries(Object.entries(declaration.data.operations).map(([id, candidate]) => {
    const parsed = z.object({ kind: z.string() }).passthrough().safeParse(candidate)
    if (!parsed.success) return [id, candidate]
    const { kind, ...fields } = parsed.data
    switch (kind) {
      case 'command':
      case 'probe': {
        if ('program' in fields || kind === 'probe' && 'effect' in fields) {
          throw new AppCardError('PRESET_INVALID', `Preset ${id} cannot override program or its fixed observational effect`)
        }
        const { executable, args, ...rest } = fields
        return [id, {
          ...rest, kind: 'exec', ...kind === 'probe' ? { effect: 'observe' } : {},
          program: { kind: 'argv', executable, args },
        }]
      }
      case 'script': {
        if ('program' in fields) throw new AppCardError('PRESET_INVALID', `Preset ${id} cannot override program`)
        const { interpreter, source, args, ...rest } = fields
        return [id, { ...rest, kind: 'exec', program: { kind: 'script', interpreter, source, args } }]
      }
      case 'agent-task': return [id, { ...fields, kind: 'agent' }]
      case 'inspection-report': return [id, { ...fields, kind: 'flow' }]
      default: return [id, candidate]
    }
  }))
  return { ...declaration.data, operations }
}
