import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildReview, validateReview } from '../src/review.ts'
import { canonicalJson, digest, executionDigest } from '../src/digest.ts'
import type { CardDeclaration, CardProposal, ProposalId } from '../src/types.ts'

async function proposal(): Promise<CardProposal> {
  const declaration = JSON.parse(await readFile(new URL('../examples/minimal.json', import.meta.url), 'utf8')) as CardDeclaration
  const contexts = {
    local: { kind: 'host' as const, cwd: '/tmp', argvPrefix: [], identity: 'context-identity', display: 'DSH Host /tmp' },
  }
  return {
    id: randomUUID() as ProposalId, declaration, expectedRevision: 0,
    executionDigest: executionDigest(declaration, contexts), documentDigest: digest(declaration),
    contexts, askRef: 'user ask', createdAt: 1234,
  }
}

describe('frozen execution review', () => {
  it('owns completeness validation without adding an intent to generic questions', async () => {
    const review = buildReview(await proposal(), null).document
    expect(validateReview({ ...review, contexts: [] }).contexts).toEqual([])
    for (const change of [
      { executionDigest: 'a'.repeat(64) }, { toRevision: 0 }, { sections: [] },
      { sections: [review.sections[0], review.sections[0]] }, { approved: true },
    ]) expect(() => validateReview({ ...review, ...change })).toThrow()
  })
  it('shows concrete commands, context, static inputs, triggers and exact digest without executing them', async () => {
    const candidate = await proposal()
    const review = buildReview(candidate, null)
    expect(review.document.executionDigest).toBe(candidate.executionDigest)
    expect(review.document.contexts).toEqual([{ id: 'local', label: 'DSH Host /tmp', kind: 'host', cwd: '/tmp' }])
    expect(review.detail).toContain("'node' '-e'")
    expect(review.detail).toContain('process.stdout.write')
    expect(review.detail).toContain('打开或手动刷新')
    expect(review.detail).toContain('没有用户可变参数')
    expect(review.detail).toContain('声明为观察用途，不代表已证明无副作用')
    expect(review.detail).toContain('此次发布本身不执行应用命令或检查')
    expect(review.detail).toContain('说明（不扩大授权范围）')
    expect(review.document.sections.every(section => section.changed)).toBe(true)
    expect(buildReview(candidate, candidate.declaration).document.sections.every(section => !section.changed)).toBe(true)
  })

  it('keeps layout changes outside execution identity and includes all static execution data', async () => {
    const candidate = await proposal()
    const layout = { ...candidate.declaration, ui: { ...candidate.declaration.ui, surfaces: [] } }
    expect(executionDigest(layout, candidate.contexts)).toBe(candidate.executionDigest)
    expect(executionDigest({ ...layout, data: { changed: true } }, candidate.contexts)).not.toBe(candidate.executionDigest)
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }))
    expect(() => canonicalJson({ value: undefined })).toThrow('plain JSON')
    expect(() => canonicalJson({ value: Infinity })).toThrow('plain JSON')
  })
})
