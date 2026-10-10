/** Shared wire validation for the three directory operations. */
import { z } from 'zod';
export const listInput=z.object({query:z.string().max(1000).optional(),archived:z.boolean().optional()}).strict();
export const inspectInput=z.object({machine_id:z.string(),refresh:z.boolean().optional(),path_id:z.string().optional(),query:z.string().max(1000).optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().positive().max(30).optional()}).strict();
export const manageInput=z.object({action:z.enum(['create','update','archive','restore']),machine_id:z.string().optional(),revision:z.string().optional(),machine:z.record(z.string(),z.json()).optional(),notes:z.string().max(20000).optional(),message:z.string().max(4000).optional()}).strict();
export const refreshInput=z.object({machine_id:z.string(),path_id:z.string().optional()}).strict();
const inputs={list:listInput,inspect:inspectInput,manage:manageInput,refresh:refreshInput,networks:z.object({}).strict()};
const descriptors=Object.entries(inputs).map(([method,schema])=>({
  id:`dsh-machine-apps#machineMgmt/${method}`,service:'machineMgmt',namespace:'machineMgmt',method,invocation:{kind:'direct'},
  parameters:[{name:'args',wire:'args',source:'json',codec:{mode:'strict',typeSymbol:`machine/${method}Input`,create:()=>schema}}],
  result:{mode:'strict',typeSymbol:'machine/result',create:()=>z.json()},sourceLocation:{file:'index.mjs',line:1,column:1}
}));
export const TYPERT={package:'dsh-machine-apps',face:'host',schemas:[],invocations:descriptors,model:{services:[{key:'machineMgmt',exportName:'MachineManagement',description:'Text machine archives shared by tools and UI.',summary:'Machine archives',tags:[],jsDoc:'/** Text machine archives. */',members:Object.keys(inputs).map(name=>({kind:'method',name,signature:`${name}(args: object): Promise<object>`,summary:`${name} machine archives`,jsDoc:`/** ${name} machine archives. */`})),types:[]}],events:[],objects:[]}};
export default {package:'dsh-machine-apps',descriptors};
