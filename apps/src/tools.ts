/** Model-facing proposal and authorized operation consumers. @module @deepseek-ai/dsh-app-cards/tools */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CardProposal, CardSnapshot, JsonValue, MachineId, ProposalId, RunRecord } from './types.ts'
import { AppCardError } from './errors.ts'
import { describeDeclaration,parseDeclaration } from './declaration.ts'
import { createAppCatalog,validateUi,catalogApis } from './ui-catalog.ts'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import {installedExtensions} from './extensions/installed.ts'
import {dynamicPackages} from './extensions/dynamic-schema.ts'
import {uiFunctions} from './ui-functions.ts'

/** Private closures keep publication authority out of Remote and arbitrary model JSON. */
export interface AppToolOperations {
  read(machineId: MachineId): Promise<CardSnapshot>
  propose(value: unknown, revision: number, askRef: string): Promise<CardProposal>
  review(id: ProposalId, agent: Agent, signal: AbortSignal): Promise<{ revision: number }>
  invoke(machineId: MachineId, revision: number, actionId: string, input: JsonValue, requestId: string): Promise<RunRecord>
  refresh(machineId: MachineId, revision: number, requestId: string): Promise<RunRecord[]>
  readRun(runId: string): RunRecord
  remove(machineId: MachineId, revision: number, agent: Agent, signal: AbortSignal): Promise<void>
}

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
const machine = { type: 'string' as const, required: true as const, description: 'Exact machine id from machine_list.' }
const revision = { type: 'integer' as const, required: true as const, description: 'Current revision returned by app_cards_read.' }
const request = { type: 'string' as const, required: true as const, description: 'Fresh UUID for this request; retain it when retrying the identical request.' }

/** Register model tools as fiber-owned effects.
 * @param ctx - plugin context with tools.
 * @param operations - service-owned private operations.
 * @param reviewTimeoutMs - human review deadline.
 */
export function registerAppTools(ctx: Context, operations: AppToolOperations, reviewTimeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'app_cards_describe',
    description: 'Read the supported application declaration fields and component catalog before preparing cards. Primitives are exec, transform, agent and flow. Only a human-reviewed published definition can execute.',
    parameters: {
      topic:{type:'string',enum:['overview','schema','components','extensions','functions'],description:'Default overview is compact. Components includes component and function schemas. Functions lists pure reactive helpers; extensions describes independent component development.'},
      declaration_json:{type:'string',description:'Optional complete draft to validate without saving, publishing or executing anything.'},
    },
    output,
    execute(args) {
      if(args.topic==='functions')return Promise.resolve(JSON.stringify({functions:uiFunctions.map(f=>({name:f.name,returnType:f.returnType,description:f.description})),schemaTopic:'components',guide:'app-cards-authoring/references/interactions.md',rules:['Use {call:name,args:{...}} with nested paths/calls.','Input writeback requires a direct /form or /local path; computed values are read-only.','Button actions resolve structured input at click time; visible invalid fields block submission by default.','Hidden fields retain drafts. Hiding is not submission filtering: explicitly choose the effective action values.']}))
      if(args.topic==='extensions')return Promise.resolve(JSON.stringify({skill:'app-cards-extensions',packages:[...installedExtensions,...dynamicPackages()].map(p=>({id:p.id,version:p.version,description:p.description,components:p.components.map(c=>c.name),delivery:installedExtensions.includes(p)?'bundled':'dynamic'})),workflow:'Independent trusted packages: extension.json + client.tsx; node lib/extensionctl.js build SOURCE OUT; install OUT --trust-code. Refresh browser; no plugin rebuild or DSH restart. Use list / activate KEY for versions and rollback. Published declarations are checked before activation. Existing operation approvals still apply.',visuals:{colorScale:['thermal','reverse-thermal'],range:['colorMin','colorMax'],value:'colorValue defaults to value',progress:'min/max/marker accept numeric data bindings',card:'warning + warningText, independent of numeric color',freshness:'Absolute /checks bindings expire locally; relative list bindings require an explicit fresh binding'}}))
      if(args.declaration_json){
        try {const d=parseDeclaration(JSON.parse(args.declaration_json));validateUi(d);return Promise.resolve(JSON.stringify({valid:true,apps:Object.keys(d.apps),surfaces:d.ui.surfaces.length,actions:Object.keys(d.actions),checks:Object.keys(d.checks)}))}
        catch(error){return Promise.resolve(JSON.stringify({valid:false,error:error instanceof Error?error.message:String(error)}))}
      }
      if(!args.topic||args.topic==='overview')return Promise.resolve(JSON.stringify({skill:'app-cards-authoring',workflow:['Read the skill and inspect the real application','Read existing cards; preserve unrelated apps and useful UX','Design custom UI, bind observations and explicit actions','Validate with this tool declaration_json; propose creates an inert preview','Publish approved execution definitions; test refresh and authorized controls'],components:catalogApis().map(a=>a.name),topics:['schema','components','extensions'],extensionSkill:'app-cards-extensions',monitoring:'Optional monitoring.intervalMs >= 5000; visible panels only, no agent-backed periodic checks',preview:'Pending proposals appear in the machine application cards version selector. Preview controls never execute.'}))
      const processor = new MessageProcessor([createAppCatalog()], undefined, { version: 'v0.9.1' })
      try {
        return Promise.resolve(JSON.stringify({
          ...(args.topic==='schema'?{declaration:describeDeclaration()}:{catalog:processor.getClientCapabilities({ includeInlineCatalogs: true })}),
          rules: [
            'Use ui.previewScenarios for inert normal/error/stale/receipt examples in the real machine panel; never substitute hand-drawn HTML for actual component rendering.',
            'Status defaults to compact (details on demand); RunReceipt hides idle by default and can aggregate actionIds. Gauge variant:compact preserves the bar and marker. See app-cards-authoring/references/ui-design.md for layout behavior.',
            'MachineId must already be declared; revision is current revision + 1.',
            'Schema-valued fields use the DSH JSON Schema subset: type, properties, required, additionalProperties, items, enum, const, oneOf.',
            'Bind action context input using {path:"/form"}; application action input references use {ref:"/input"}.',
            'Only /form and /local are writable by input components; checks and receipts are Host facts.',
            'Host contexts require configured hostRoots; SSH contexts reference existing machine pathId.',
            'Propose first, then publish for one complete human execution review. An ask reference is not authorization.',
          ],
        }))
      } finally { processor.model.dispose() }
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Describe application declarations' }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_read',
    description: 'Read a machine’s published application declarations, latest evidence and operation receipts. This does not inspect the machine or change applications.',
    parameters: { machine_id: machine },
    output,
    async execute(args) { return JSON.stringify(await operations.read(args.machine_id as MachineId)) },
    presentCall: args => ({ card: 'generic', kind: 'read', title: `Read applications on ${args.machine_id}` }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_propose',
    description: 'Prepare a versioned application declaration for an explicit user request. A proposal is inert: it neither executes commands nor grants authorization. Use app_cards_publish to present the exact execution list for one human decision.',
    parameters: {
      declaration_json: { type: 'string', required: true, description: 'Complete dsh.app-cards/v1 JSON document with revision expected_revision + 1.' },
      expected_revision: revision,
      ask_ref: { type: 'string', required: true, description: 'The user request that requires this application declaration change.' },
    },
    output,
    async execute(args) {
      const proposal = await operations.propose(JSON.parse(args.declaration_json), args.expected_revision, args.ask_ref)
      return JSON.stringify({ proposalId: proposal.id, revision: proposal.declaration.revision, executionDigest: proposal.executionDigest })
    },
    presentCall: () => ({ card: 'generic', kind: 'edit', title: 'Prepare application declaration' }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_publish',
    description: 'Present one frozen application execution list to the human and publish only after their explicit approval. The approval authorizes subsequent declared executions without per-run questions. Publication does not run application commands or checks.',
    parameters: { proposal_id: { type: 'string', required: true, description: 'Proposal id returned by app_cards_propose.' } },
    output, timeoutMs: reviewTimeoutMs,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new AppCardError('REVIEW_AGENT', 'Application publication requires the user task’s live root agent')
      return JSON.stringify(await operations.review(args.proposal_id as ProposalId, exec.agent, exec.signal))
    },
    presentCall: () => ({ card: 'generic', kind: 'edit', title: 'Review and publish application declaration' }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_invoke',
    description: 'Run one action from a human-approved application declaration. Only the declared operation and validated parameters can run; no new command source is accepted. Returns a run receipt, not a health claim.',
    parameters: {
      machine_id: machine, revision, request_id: request,
      action_id: { type: 'string', required: true, description: 'Action id in the published declaration.' },
      input_json: { type: 'string', required: true, description: 'JSON parameters for the declared action.' },
    },
    output,
    async execute(args) {
      return JSON.stringify(await operations.invoke(args.machine_id as MachineId, args.revision, args.action_id,
        JSON.parse(args.input_json) as JsonValue, args.request_id))
    },
    presentCall: args => ({ card: 'generic', kind: 'execute', title: `Run ${args.action_id} on ${args.machine_id}` }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_refresh',
    description: 'Run a machine’s declared application checks once. Observation results are separate from action success; this never starts continuous monitoring.',
    parameters: { machine_id: machine, revision, request_id: request },
    output,
    async execute(args) { return JSON.stringify(await operations.refresh(args.machine_id as MachineId, args.revision, args.request_id)) },
    presentCall: args => ({ card: 'generic', kind: 'read', title: `Inspect applications on ${args.machine_id}` }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_run_read',
    description: 'Read the result of an admitted application run without repeating its operation.',
    parameters: { run_id: { type: 'string', required: true, description: 'Run id returned by application invocation or refresh.' } },
    output,
    execute(args) { return Promise.resolve(JSON.stringify(operations.readRun(args.run_id))) },
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Read application operation receipt' }),
  }))
  ctx.tools.register(defineTool({
    name: 'app_cards_remove',
    description: 'Ask the user to remove a machine’s shared application cards. Removal withdraws future executions; it never uninstalls an application or stops a service.',
    parameters: { machine_id: machine, revision },
    output, timeoutMs: reviewTimeoutMs,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new AppCardError('REVIEW_AGENT', 'Card removal requires the user task’s live root agent')
      await operations.remove(args.machine_id as MachineId, args.revision, exec.agent, exec.signal)
      return 'Application cards removed; applications were not uninstalled.'
    },
    presentCall: args => ({ card: 'generic', kind: 'delete', title: `Remove application cards for ${args.machine_id}` }),
  }))
}
