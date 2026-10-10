/** Recorded app-card tools through `dsh --profile acp`; missing human review must fail closed. */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import {
  assertSessionFixtureVersion, fixtureContext, formatSystemPromptSnapshot,
  formatToolSchemasSnapshot, normalizeSessionSnapshot, normalizeSessionSnapshots, normalizeStdout,
  normalizedSystemPrompts, normalizedToolSchemas, parseSnapshotManifest,
  redactSessionSnapshotIds, runScenario, type InputScript,
} from '@deepseek-ai/dsh-session-snapshot'
import { normalizeProposalIds, proposalIds, snapshotRows as rows } from './fixtures/session.ts'

const execute = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url))
const scenarioRoot = fileURLToPath(new URL('./snapshots/review-unavailable/', import.meta.url))
const sessionPath = join(scenarioRoot, 'session.v3.jsonl')
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
if (!['record', 'replay', 'refresh'].includes(mode)) throw new Error(`Unknown snapshot mode: ${mode}`)

function promptFromFixture(log: string): string {
  const row = rows(log).find(row => row['type'] === 'user/message')
  const data = row?.['data'] as { content?: { type: string; text?: string }[] } | undefined
  const text = data?.content?.find(block => block.type === 'text')?.text
  if (text === undefined) throw new Error('Recorded Session has no user prompt')
  return text
}

// The shipped ACP profile exposes a different shell tool catalog on Windows.
it.skipIf(process.platform === 'win32')('records declaration preparation and refuses publication without a human review answerer', async () => {
  const manifestPath = join(scenarioRoot, 'snapshot.yml')
  const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
  expect(manifest.recording).toBe('live')
  const existing = await readFile(sessionPath, 'utf8')
  expect(assertSessionFixtureVersion('session.v3.jsonl', existing)).toBe(3)
  const scratch = await mkdtemp(join(fixtureRoot, '.recorded-'))
  try {
    for (const name of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(name, scratch)
    let overrideFile: string | undefined
    if (mode !== 'record') {
      overrideFile = join(scratch, 'replay.override.json')
      const script = deriveReplayScript(parseSessionLog(existing))
      // Rebind only the proposal identifier to its newly persisted tool result.
      const replay = JSON.stringify(script).replaceAll('{{id:1}}',
        '{{fromRequest:\\\"proposalId\\\":\\\"([^\\\"]+)\\\"}}')
      await writeFile(overrideFile, replay)
    }
    const input: InputScript = {
      steps: [
        { op: 'initialize' }, { op: 'newSession' },
        { op: 'prompt', text: promptFromFixture(existing) },
      ],
    }
    const result = await runScenario(input, {
      agent: {
        binScript: join(repoRoot, 'apps/cli/src/bin.ts'),
        configPath: join(fixtureRoot, 'recorded/cordis.yml'),
        tsconfigPath: join(repoRoot, 'tsconfig.json'), profile: 'acp',
      },
      mode: mode === 'record' ? 'record' : 'replay',
      fixtureFile: sessionPath,
      ...(overrideFile === undefined ? {} : { overrideFile }),
      workspaceDir: join(scenarioRoot, 'workspace'),
      async prepareWorkspace(cwd) {
        // The snapshot launcher's bare-package search does not resolve the enclosing package's self-reference.
        const namespace = join(cwd, '.dsh/profiles/node_modules/@deepseek-ai')
        await mkdir(namespace, { recursive: true })
        await symlink(fileURLToPath(new URL('../', import.meta.url)), join(namespace, 'dsh-app-cards'), 'dir')
        const catalog = join(cwd, '.dsh/inventory')
        await execute('git', ['init', '-q', catalog])
        await execute('git', ['-C', catalog, 'add', 'machines'])
        await execute('git', ['-C', catalog, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Snapshot inventory'])
      },
    }).catch((error: unknown) => {
      throw new Error(`ACP snapshot launch failed: ${JSON.stringify(error)}`, { cause: error })
    })
    expect(result.sessionLogs).toHaveLength(1)
    const raw = result.sessionLogs[0]!.content
    expect(raw).toContain('app-cards-authoring')
    expect(raw).toContain('App cards: create, revise, or diagnose')
    expect(raw).not.toContain('# Application-card authoring')
    const log = normalizeProposalIds(raw)
    const context = { cwd: result.cwd, cwdAliases: result.cwdAliases, sessionIds: [result.sessionLogs[0]!.id] }
    const events = parseSessionLog(raw)
    const calls = events.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['app_cards_describe', 'app_cards_read', 'app_cards_propose', 'app_cards_publish', 'app_cards_read'])
    expect(raw).toContain('no user-questions answerer accepted the request')
    expect(raw).toContain('REVIEW_UNAVAILABLE_NO_PUBLICATION')
    expect(proposalIds(raw)).toHaveLength(1)
    const results = events.filter(event => event.type === 'tool/result')
      .map(event => event.data.message.content[0])
    expect(results.map(result => result.isError ?? false)).toEqual([false, false, false, true, false])
    const finalText = results.at(-1)?.content.find(block => block.type === 'text')
    expect(finalText?.type).toBe('text')
    expect(JSON.parse(finalText?.type === 'text' ? finalText.text : '')).toMatchObject({
      revision: 0, declaration: null, checks: {},
    })
    const prompts = normalizedSystemPrompts(log, context)
    const schemas = normalizedToolSchemas(log, context)
    expect(prompts).toHaveLength(1)
    expect(schemas).toHaveLength(1)
    const outputs = {
      'system-prompt.expected.md': formatSystemPromptSnapshot(prompts[0]!),
      'tool-schemas.expected.json': formatToolSchemasSnapshot(schemas[0]!),
      // Model selectors belong to ACP/provider coverage; this package pins session updates.
      'transcript.expected.jsonl': normalizeStdout(`${rows(result.rawStdout)
        .filter(row => row['method'] === 'session/update').map(row => JSON.stringify(row)).join('\n')}\n`, context),
    }
    if (mode !== 'replay') {
      const normalized = normalizeSessionSnapshot(redactSessionSnapshotIds([log])[0]!,
        { ...context, sessionIds: [] }, { identityMode: 'preserve' })
      expect(assertSessionFixtureVersion('session.v3.jsonl', normalized)).toBe(3)
      await writeFile(sessionPath, normalized)
      for (const [name, value] of Object.entries(outputs)) await writeFile(join(scenarioRoot, name), value)
    }
    const expected = await readFile(sessionPath, 'utf8')
    expect(normalizeSessionSnapshots([log], context)).toEqual(normalizeSessionSnapshots([expected], fixtureContext(expected)))
    for (const [name, value] of Object.entries(outputs)) expect(value).toBe(await readFile(join(scenarioRoot, name), 'utf8'))
  } finally {
    vi.unstubAllEnvs()
    await rm(scratch, { recursive: true, force: true })
  }
})
