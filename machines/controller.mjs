/** Browser-only ephemeral observations. No second durable source of truth. */
export class DirectoryController {
  constructor(api) { this.api=api; this.listeners=new Set(); this.generation=0; this.state={rows:[],cache:{},pending:{},errors:{},loading:false,networks:null,openKey:0,refreshKey:0}; }
  subscribe=(fn)=>{this.listeners.add(fn);return()=>this.listeners.delete(fn);};
  snapshot=()=>this.state;
  set(patch){this.state={...this.state,...patch};for(const fn of this.listeners)fn();}
  close(){this.generation++;this.set({loading:false,pending:{}});}
  async refresh(archived=false,opening=false) {
    const generation=++this.generation, current=()=>generation===this.generation;
    this.set({loading:true,errors:{},pending:{},openKey:this.state.openKey+(opening?1:0),refreshKey:this.state.refreshKey+1});
    try {
      const result=await this.api.list({archived});if(!current())return;
      this.set({rows:result.machines,errors:Object.fromEntries(result.errors.map(e=>[e.id,e.error]))});
      const network=this.api.networks?.({}).then(n=>{if(current())this.set({networks:n});}).catch(e=>{if(current())this.set({errors:{...this.state.errors,networks:e.message}});});
      const queue=[...result.machines];
      await Promise.all(Array.from({length:3},async()=>{while(queue.length&&current()){
        const m=queue.shift();this.set({pending:{...this.state.pending,[m.id]:true}});
        try {const cached=await this.api.inspect({machine_id:m.id});if(!current())return;
          this.set({cache:{...this.state.cache,[m.id]:cached}});
          if(!archived){const fresh=await this.api.refresh({machine_id:m.id});if(!current())return;this.set({cache:{...this.state.cache,[m.id]:fresh}});}
        }catch(e){if(current())this.set({errors:{...this.state.errors,[m.id]:e.message}});}
        finally{if(current())this.set({pending:{...this.state.pending,[m.id]:false}});}
      }}));
      await network;
    }catch(e){if(current())this.set({errors:{...this.state.errors,directory:e.message}});}
    finally{if(current())this.set({loading:false});}
  }
  remember(data){const errors={...this.state.errors};delete errors[data.machine.id];this.set({cache:{...this.state.cache,[data.machine.id]:data},errors});}
}
export function machineStatus(data){
  const observations=data?.connections?.map(c=>c.observation).filter(Boolean)??[];
  if(observations.some(o=>o.status==='unreachable'))return 'attention';
  if(observations.some(o=>o.status==='reachable')||data?.virtualMachine?.reachability==='reachable')return 'reachable';
  return 'unknown';
}
export function connectionStatus(observation){return !observation?'unknown':observation.status==='reachable'?'reachable':'attention';}
export function probeTooltip(observation,pending=false){
  const label=!observation?'尚未检测':observation.status==='reachable'?'连接成功':'连接失败';
  return [pending?'正在检测':label,pending?`上次结果：${label}`:'',observation?.message,
    observation?.observedAt?`检测时间：${new Date(observation.observedAt).toLocaleString()}`:'',
    observation?.lastSuccessAt?`上次成功：${new Date(observation.lastSuccessAt).toLocaleString()}`:''].filter(Boolean).join('\n');
}
export function machineTooltip(data,pending=false,error=''){
  return [error?`刷新失败：${error}`:'',...(data?.connections??[]).map(c=>`${c.host}:${c.port}\n${probeTooltip(c.observation,pending)}`)].filter(Boolean).join('\n\n')||(pending?'正在检测':'尚未检测');
}
export function connectionLabel(c,index){return c.label&&c.label!==c.id?c.label:`SSH${index?` · 连接 ${index+1}`:''}`;}
export function mentions(draft){return [...draft.matchAll(/(?:^|\s)@machine:([a-z0-9][a-z0-9_-]{0,63})(?=\s|$)/g)].map(m=>m[1]);}
/** Incomplete/unknown IDs are plain draft text, never an attached machine. */
export function resolvedMentions(draft,catalog){return [...new Set(mentions(draft))].filter(id=>Object.hasOwn(catalog,id)).map(id=>({id,name:catalog[id].name}));}
export function removeMention(draft,id){return draft.replace(new RegExp(`(^|\\s)@machine:${id}(?=\\s|$)`,'g'),'$1').replace(/ +$/,'');}
