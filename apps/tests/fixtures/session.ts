/** App-owned proposal identity normalization for recorded Session fixtures. */
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'

/** Decode recorded JSONL rows without materializing replay envelopes.
 * @param log - complete or projected Session JSONL.
 * @returns parsed header and event rows.
 */
export function snapshotRows(log: string): Record<string, unknown>[] {
  return log.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

/** Collect identities only from successful app-card proposal results.
 * @param log - complete or projected Session JSONL.
 * @returns proposal ids in tool-result order.
 */
export function proposalIds(log: string): string[] {
  const events = parseSessionLog(log)
  const calls = new Set(events.flatMap(event => event.type === 'tool/call' && event.data.name === 'app_cards_propose'
    ? [event.data.callId] : []))
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return []
    const result = event.data.message.content[0]
    if (!calls.has(result.toolCallId) || result.isError) return []
    const text = result.content.find(block => block.type === 'text')
    if (text?.type !== 'text') throw new Error('Proposal result has no JSON text')
    const proposal = JSON.parse(text.text) as { proposalId: string }
    return [proposal.proposalId]
  })
}

/** Tokenize proposal identities across tool results, calls, and streamed argument fragments.
 * @param log - complete or projected Session JSONL.
 * @returns JSONL preserving proposal relationships and stream-fragment count.
 */
export function normalizeProposalIds(log: string): string {
  const ids = proposalIds(log)
  const records = snapshotRows(log)
  for (const record of records) {
    if (record['type'] !== 'assistant/message') continue
    const data = record['data'] as { stream: { type: string; name?: string; args?: string[] }[] }
    for (const group of data.stream) {
      if (group.type !== 'tool-call-chunks' || group.name !== 'app_cards_publish' || group.args === undefined) continue
      for (const [index, id] of ids.entries()) {
        const start = group.args.join('').indexOf(id)
        if (start < 0) continue
        const end = start + id.length
        let offset = 0
        // A complete token in one delta lets replay rebind it before streaming.
        group.args = group.args.map((fragment) => {
          const left = offset
          offset += fragment.length
          if (offset <= start || left >= end) return fragment
          return (left <= start ? `${fragment.slice(0, start - left)}{{id:${index + 1}}}` : '')
            + (offset > end ? fragment.slice(end - left) : '')
        })
      }
    }
  }
  const joined = `${records.map(record => JSON.stringify(record)).join('\n')}\n`
  return ids.reduce((text, id, index) => text.replaceAll(id, `{{id:${index + 1}}}`), joined)
}
