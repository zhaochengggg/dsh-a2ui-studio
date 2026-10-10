/**
 * Pure JSONata evaluation in a credential-free, terminable worker.
 * @module @deepseek-ai/dsh-app-cards/expression
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod/v3'
import { AppCardError, errorMessage } from './errors.ts'
import type { JsonValue } from './types.ts'
declare const __APP_CARDS_BUNDLED__: boolean

// A fixed JavaScript module works under plain built Node and source ESM without inheriting loader flags.
const workerSource = `
import { parentPort, workerData } from 'node:worker_threads';
const { default: jsonata } = await import(workerData.module);
try {
  const expression = jsonata(workerData.source);
  expression.assign('eval', undefined);
  const value = await expression.evaluate(workerData.input);
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol'
      || typeof item === 'bigint' || (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0)))) {
      throw new Error('Expression must return lossless JSON, not a missing value or function');
    }
    return item;
  });
  if (Buffer.byteLength(serialized) > workerData.outputLimitBytes) {
    parentPort.postMessage({ error: { code: 'EXPRESSION_OUTPUT_LIMIT', message: 'Expression JSON exceeds outputLimitBytes' } });
  } else {
    parentPort.postMessage({ value: serialized });
  }
} catch (error) {
  parentPort.postMessage({ error: { code: 'EXPRESSION_INVALID', message: String(error.message ?? error).slice(0, 1024) } });
}
`
const workerMessage = z.union([
  z.object({ value: z.string() }).strict(),
  z.object({ error: z.object({ code: z.string(), message: z.string() }).strict() }).strict(),
])
const json = z.custom<JsonValue>(isJsonValue, 'Expression result is not lossless JSON')

/** Evaluate JSONata without external functions or $eval and await worker termination on every outcome.
 * Worker heap and stack ceilings supplement the caller's wall-clock and serialized UTF-8 output bounds.
 * @param source - complete reviewed JSONata source.
 * @param input - JSON available to the expression.
 * @param options - deadline, JSON byte limit and cancellation.
 * @returns the lossless JSON result; rejects on timeout, cancellation, oversized or non-JSON output.
 */
export async function evaluateExpression(
  source: string,
  input: JsonValue,
  options: { timeoutMs: number; outputLimitBytes: number; signal?: AbortSignal },
): Promise<JsonValue> {
  for (const [name, value] of Object.entries({ timeoutMs: options.timeoutMs, outputLimitBytes: options.outputLimitBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new AppCardError('EXPRESSION_LIMIT', `${name} must be a positive timer-sized integer`)
    }
  }
  if (options.signal?.aborted) throw new AppCardError('ABORTED', 'Expression was cancelled')
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
    workerData: {
      module: typeof __APP_CARDS_BUNDLED__ !== 'undefined' && __APP_CARDS_BUNDLED__
        ? new URL('./jsonata.cjs',import.meta.url).href
        : pathToFileURL(createRequire(import.meta.url).resolve('jsonata')).href,
      source, input, outputLimitBytes: options.outputLimitBytes,
    },
    env: {}, execArgv: [], stdout: true, stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await new Promise<JsonValue>((resolve, reject) => {
      abort = () =>{  reject(new AppCardError('ABORTED', 'Expression was cancelled')) }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      timer = setTimeout(() =>{  reject(new AppCardError('EXPRESSION_TIMEOUT', 'Expression exceeded timeoutMs')) }, options.timeoutMs)
      worker.once('error', (error) =>{  reject(new AppCardError('EXPRESSION_WORKER', errorMessage(error))) })
      worker.once('exit', (code) =>{  reject(new AppCardError('EXPRESSION_WORKER', `Expression worker exited before returning JSON (${code})`)) })
      worker.once('message', (raw: unknown) => {
        const parsed = workerMessage.safeParse(raw)
        if (!parsed.success) {
          reject(new AppCardError('EXPRESSION_PROTOCOL', 'Expression worker returned an invalid message'))
          return
        }
        const message = parsed.data
        if ('error' in message) {
          reject(new AppCardError(message.error.code, message.error.message))
          return
        }
        if (Buffer.byteLength(message.value) > options.outputLimitBytes) {
          reject(new AppCardError('EXPRESSION_PROTOCOL', 'Expression worker returned invalid or oversized JSON'))
          return
        }
        try {
          resolve(json.parse(JSON.parse(message.value)))
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) options.signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
