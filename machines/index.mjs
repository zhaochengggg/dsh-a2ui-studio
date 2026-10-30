/** Three machine tools and their shared browser service. No execution or workflow journal. */
import { Service } from '@deepseek-ai/cordis';
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import {homedir} from 'node:os';
import {join} from 'node:path';
import { MachineStore } from './store.mjs';
import { listInput,inspectInput,manageInput,refreshInput } from './remote.mjs';
import {observeVM,observeNetworks} from './observations.mjs';
const string=(description,required=false)=>({type:'string',description,...(required?{required:true}:{})});
const connection={type:'object',additionalProperties:false,properties:{id:string('Stable connection id',true),host:string('IP address or hostname',true),user:string('SSH user',true),port:{type:'integer'},identityFile:string('Absolute private key path; never key contents'),fingerprint:string('Trusted SHA256 host-key fingerprint, not an unverified scan'),label:string('Optional connection label')}};
const specs=[
  ['machine_list','list','Find machines by ID, name or alias. Returns a compact directory. Archived entries are separate.',{query:string('Search names/aliases/purpose'),archived:{type:'boolean'}}],
  ['machine_inspect','inspect','Read machine connections, current notes and important history. Resolve @machine:<id> here. History is searchable and paginated; refresh only tests the selected SSH connection without running maintenance.',{machine_id:string('Stable machine ID',true),refresh:{type:'boolean'},path_id:string('Optional connection ID'),query:string('Search important history'),offset:{type:'integer'},limit:{type:'integer'}}],
  ['machine_manage','manage','Register, update, archive or restore a machine archive. This changes local records, NEVER the remote machine. Inspect first and supply revision for updates. notes replaces current notes; message appends one meaningful history entry. No plan or audit form required. Do not store secrets or unverified host fingerprints.',{action:{type:'string',enum:['create','update','archive','restore'],required:true},machine_id:string('ID; omit on create to generate one'),revision:string('Revision returned by inspect; required except create'),machine:{type:'object',additionalProperties:false,description:'Fields to create or update; other fields are preserved.',properties:{name:string('Display name'),purpose:string('Short purpose'),aliases:{type:'array',items:{type:'string'}},connections:{type:'array',items:connection},defaultConnection:string('Preferred connection ID')}},notes:string('Current machine notes, Markdown; replaces previous notes'),message:string('Optional important history entry; no command transcripts')}]
];
export default class MachineManagement extends TypertRemoteService {
  static inject=['tools'];
  static Config=Schema.object({root:Schema.string().default(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'machines')),sshDir:Schema.string().default(join(process.env.DSH_HOME||join(homedir(),'.dsh'),'machine-mgmt','ssh'))});
  constructor(ctx,config) {
    super(ctx,'machineMgmt'); this.store=new MachineStore(config.root,config.sshDir);
    this.vmCache=new Map();this.refreshes=new Map();
    for(const method of ['list','inspect','manage','refresh','networks']) Remote(undefined,{kind:'method',name:method,addInitializer:fn=>fn.call(this)});
  }
  async [Service.init]() {
    await this.store.locked(()=>this.store.project());
    for(const [name,method,description,parameters] of specs) this.ctx.tools.register(defineTool({name,description,parameters,
      output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},timeoutMs:45000,
      isConcurrencySafe:args=>method==='list'||(method==='inspect'&&!args.refresh),
      execute:async args=>JSON.stringify(await this[method](args)),
      presentCall:args=>({card:'generic',title:method==='list'?'计算机目录':method==='inspect'?'读取计算机档案':'更新计算机档案',kind:method==='manage'?'edit':'read',content:[{type:'text',text:args.machine_id??args.query??''}]})
    }));
  }
  async list(args={}) {return this.store.list(listInput.parse(args));}
  async inspect(args) {const data=await this.store.inspect(inspectInput.parse(args));return {...data,virtualMachine:this.vmCache.get(data.machine.id)??null};}
  async networks(){return observeNetworks();}
  async refresh(raw){
    const args=refreshInput.parse(raw),key=JSON.stringify(args);
    if(this.refreshes.has(key))return this.refreshes.get(key);
    const task=(async()=>{
      const data=await this.store.inspect({machine_id:args.machine_id});
      if(data.machine.archived)throw new Error('Archived machines cannot be probed');
      for(const c of data.machine.connections)if(!args.path_id||c.id===args.path_id)await this.store.inspect({machine_id:data.machine.id,refresh:true,path_id:c.id});
      if(!args.path_id&&data.machine.locator?.kind==='libvirt')this.vmCache.set(data.machine.id,await observeVM(data.machine));
      return this.inspect({machine_id:data.machine.id});
    })();
    this.refreshes.set(key,task);try{return await task;}finally{this.refreshes.delete(key);}
  }
  async manage(args) {return this.store.manage(manageInput.parse(args));}
}
