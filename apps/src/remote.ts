import {z} from 'zod/v3';
const json: z.ZodTypeAny=z.lazy(()=>z.union([z.null(),z.string(),z.number().finite(),z.boolean(),z.array(json),z.record(json)]));
const s=z.string(), n=z.number().int().nonnegative();
const specs:Record<string,[string,z.ZodTypeAny][]>={read:[['machineId',s]],invoke:[['machineId',s],['revision',n],['actionId',s],['input',json],['requestId',s]],refresh:[['machineId',s],['revision',n],['requestId',s]],readRun:[['runId',s]],cancel:[['runId',s]],preview:[['proposalId',s]],subscribe:[]};
const descriptors=Object.entries(specs).map(([method,params])=>({
 id:`dsh-machine-apps#appCards/${method}`,service:'appCards',namespace:'appCards',method,invocation:{kind:'direct'},
 ...(method==='subscribe'?{mode:'stream',cancellation:{parameter:'signal'}}:{}),
 parameters:params.map(([name,schema])=>({name,wire:name,source:'json',codec:{mode:'strict',typeSymbol:`appCards/${method}/${name}`,create:()=>schema}})),
 result:{mode:'strict',typeSymbol:'appCards/result',create:()=>json},sourceLocation:{file:'src/index.ts',line:1,column:1}
}));
export const TYPERT={package:'dsh-machine-apps',face:'host',schemas:[],invocations:descriptors,model:{services:[{key:'appCards',exportName:'AppCardsService',description:'Model-authored application cards',summary:'Application cards',tags:[],jsDoc:'/** Application cards. */',members:Object.keys(specs).map(name=>({kind:'method',name,signature:`${name}(...args: unknown[]): unknown`,summary:name,jsDoc:`/** ${name}. */`})),types:[]}],events:[],objects:[]}};
export default {package:'dsh-machine-apps',descriptors};
