import React, {useState,useEffect,useRef,useSyncExternalStore,Component} from 'react';
import remoteDescriptor from './remote.mjs';
import css from './style.css';
import {Icon,IconButton} from '../shared/ui.tsx';
import {DirectoryController,machineStatus,connectionStatus,probeTooltip,machineTooltip,mentions,resolvedMentions,removeMention} from './controller.mjs';
export const inject=['remote','slots','sessions','conversation'];
class Boundary extends Component {state={error:null};static getDerivedStateFromError(error){return {error};}render(){return this.state.error?<div className="mm-error">机器面板未能显示：{this.state.error.message}</div>:this.props.children;}}
function Inline({value}){return value.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((s,i)=>s.startsWith('`')?<code key={i}>{s.slice(1,-1)}</code>:s.startsWith('**')?<strong key={i}>{s.slice(2,-2)}</strong>:s);}
function Purpose({value}){const [expanded,setExpanded]=useState(false);return value?<div className="mm-purpose"><p className={expanded||value.length<=85?'':'clamped'}>{value}</p>{value.length>85&&<button className="mm-link" onClick={()=>setExpanded(!expanded)}>{expanded?'收起':'展开用途'}</button>}</div>:null;}
function Connections({data,pending,busy,onRefresh,onEdit}) {
  const [expanded,setExpanded]=useState(false);
  const primary=data.connections.find(c=>c.id===data.machine.defaultConnection)||data.connections[0];
  const others=data.connections.filter(c=>c!==primary);
  const failures=others.filter(c=>connectionStatus(c.observation)==='attention');
  const endpoint=c=><div className="mm-endpoint" key={c.id}>
    <div className="mm-endpoint-line">
      <span role="img" className={'mm-dot '+connectionStatus(c.observation)+(pending?' pending':'')} title={probeTooltip(c.observation,pending)} aria-label={probeTooltip(c.observation,pending)}/>
      <div className="mm-endpoint-identity"><span className="mm-address">{c.user}@{c.host}<span>:{c.port}</span></span>{c.id===data.machine.defaultConnection&&others.length>0&&<span className="mm-badge">默认</span>}</div>
      <IconButton label={`刷新连接：${c.host}:${c.port}`} busy={pending} disabled={busy||data.machine.archived} onClick={()=>onRefresh(c.id)}/>
    </div>
    <details className="mm-endpoint-details"><summary>连接详情</summary><code>{c.command.map(x=>/\s/.test(x)?JSON.stringify(x):x).join(' ')}</code><dl><dt>密钥</dt><dd>{c.identityFile||'SSH Agent'}</dd><dt>指纹</dt><dd>{c.fingerprint||'未登记'}</dd></dl></details>
  </div>;
  return <section className="mm-connections" aria-label="连接">
    {primary?endpoint(primary):<div className="mm-empty-small">未配置连接 <button className="mm-link" onClick={onEdit}>添加</button></div>}
    {others.length>0&&<><button className="mm-more-connections" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><span>{expanded?'收起其他连接':`另有 ${others.length} 条连接`}</span>{!expanded&&failures.length>0&&<span className="mm-dot attention" role="img" aria-label="其他连接有异常" title={failures.map(c=>`${c.user}@${c.host}:${c.port}：${probeTooltip(c.observation,pending)}`).join('\n')}/>}<span aria-hidden="true">{expanded?'▴':'▾'}</span></button><div hidden={!expanded} className="mm-other-connections">{others.map(endpoint)}</div></>}
  </section>;
}
function Text({value}) {
  const blocks=[];let code=null;
  for(const [i,line] of (value??'').split('\n').entries()){
    if(line.startsWith('```')){if(code!==null){blocks.push(<pre key={i}><code>{code.join('\n')}</code></pre>);code=null;}else code=[];continue;}
    if(code!==null){code.push(line);continue;}
    blocks.push(/^#{1,3} /.test(line)?<h3 key={i}>{line.replace(/^#{1,3} /,'')}</h3>:<div className={/^[-*] /.test(line)?'mm-note-item':undefined} key={i}><Inline value={line.replace(/^[-*] /,'')||'\u00a0'}/></div>);
  }
  if(code!==null)blocks.push(<pre key="last"><code>{code.join('\n')}</code></pre>);
  return <div className="mm-prose">{blocks}</div>;
}
function NetworkValue({name,value}){if(name==='addresses')return <>{value.map(v=>`${v.address}/${v.prefix} · ${v.network}`).join('； ')||'未配置'}</>;if(name==='dhcpRanges')return <>{value.map(v=>`${v.start} – ${v.end}`).join('； ')||'未配置'}</>;return <>{typeof value==='boolean'?(value?'是':'否'):String(value??'—')}</>;}
function Editor({data,onSave,onCancel,busy}) {
  const [form,setForm]=useState(()=>({name:data?.machine.name??'',purpose:data?.machine.purpose??'',aliases:(data?.machine.aliases??[]).join(', '),connections:data?.machine.connections??[],defaultConnection:data?.machine.defaultConnection??'',notes:data?.notes??'',message:''}));
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const conn=(i,k,v)=>set('connections',form.connections.map((c,j)=>i===j?{...c,[k]:v}:c));
  return <form className="mm-editor" onSubmit={e=>{e.preventDefault();onSave({machine:{name:form.name,purpose:form.purpose,aliases:form.aliases.split(/[,，]/).map(x=>x.trim()).filter(Boolean),connections:form.connections,...(form.connections.length?{defaultConnection:form.defaultConnection||form.connections[0].id}:{})},notes:form.notes,...(form.message.trim()?{message:form.message}:{})});}}>
    <div className="mm-section-title">{data?'编辑档案':'登记一台机器'}</div>
    <div className="mm-two"><label>名称<input required maxLength={120} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="例如：V100 服务器"/></label><label>别名<input value={form.aliases} onChange={e=>set('aliases',e.target.value)} placeholder="多个别名用逗号分隔"/></label></div>
    <label>用途<input value={form.purpose} onChange={e=>set('purpose',e.target.value)} placeholder="这台机器主要用来做什么"/></label>
    <div className="mm-section-head"><h3>SSH 连接</h3><button type="button" onClick={()=>set('connections',[...form.connections,{id:`ssh-${Date.now().toString(36)}`,host:'',port:22,user:'root',identityFile:'',fingerprint:'',label:''}])}><Icon name="plus" size={14}/>添加连接</button></div>
    {form.connections.length===0&&<p className="mm-muted">可以先登记机器，稍后补充连接。</p>}
    {form.connections.map((c,i)=><fieldset key={c.id}><legend>{c.label||`连接 ${i+1}`}</legend>
      <div className="mm-two"><label>地址<input required value={c.host} onChange={e=>conn(i,'host',e.target.value)} placeholder="IP 或主机名"/></label><label>用户<input required value={c.user} onChange={e=>conn(i,'user',e.target.value)}/></label></div>
      <div className="mm-two"><label>端口<input type="number" min="1" max="65535" required value={c.port} onChange={e=>conn(i,'port',Number(e.target.value))}/></label><label>连接说明<input value={c.label||''} onChange={e=>conn(i,'label',e.target.value)} placeholder="例如：局域网"/></label></div>
      <details><summary>认证与主机身份</summary><label>密钥路径<input value={c.identityFile||''} onChange={e=>conn(i,'identityFile',e.target.value)} placeholder="私钥绝对路径（不填入密钥内容）"/></label><label>可信主机指纹<input value={c.fingerprint||''} onChange={e=>conn(i,'fingerprint',e.target.value)} placeholder="SHA256:…"/></label><p className="mm-muted">未填写指纹也可保存；连接前需核验并登记主机指纹。</p></details>
      <div className="mm-row"><label className="mm-radio"><input type="radio" name="default" checked={(form.defaultConnection||form.connections[0]?.id)===c.id} onChange={()=>set('defaultConnection',c.id)}/>默认连接</label><button className="mm-link" type="button" onClick={()=>{set('connections',form.connections.filter((_,j)=>j!==i));if(form.defaultConnection===c.id)set('defaultConnection','');}}>移除此连接</button></div>
    </fieldset>)}
    <label>当前说明<textarea rows={7} value={form.notes} onChange={e=>set('notes',e.target.value)} placeholder="值得下次记住的事实、注意事项、已知问题。支持 Markdown 文本。"/></label>
    {data&&<label>变更说明（可选）<input value={form.message} onChange={e=>set('message',e.target.value)} placeholder="只记录有意义的变化"/></label>}
    <div className="mm-actions"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button className="mm-primary" disabled={busy} type="submit">{busy?'保存中…':'保存档案'}</button></div>
  </form>;
}
export async function apply(ctx,mounted=false) {
  const dispose=mounted?async()=>{}:await ctx.remote.$mount(remoteDescriptor), remote=ctx.get('remote.machineMgmt');
  const api=Object.fromEntries(['list','inspect','manage','refresh','networks'].map(name=>[name,async args=>{const r=await remote[name](args);if(!r.ok)throw new Error(r.error.message);return r.value;}]));
  const controller=new DirectoryController(api);
  // Resolve restored drafts before the workbench is opened; no connection probes.
  const catalog=Object.fromEntries((await Promise.all([false,true].map(archived=>api.list({archived}).then(r=>r.machines).catch(()=>[])))).flat().map(m=>[m.id,m]));
  let mayClose=()=>true,opened=false; const listeners=new Set();
  const toggle=v=>{if(!v&&opened&&!mayClose())return;opened=v;for(const fn of listeners)fn();};
  const useOpen=()=>useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>opened);
  const style=document.createElement('style'); style.textContent=css; document.head.appendChild(style);
  ctx.effect(()=>()=>{style.remove();listeners.clear();controller.close();});
  function Footer(props){const open=useOpen();return <button className="mm-footer" data-wide={props.wide} title="机器档案" aria-label="机器档案" aria-expanded={open} onClick={()=>toggle(!open)}><span className="mm-footer-glyph"><Icon size={props.wide?16:18}/></span>{props.wide&&<span className="mm-footer-label">机器</span>}</button>;}
  function Dock(props){
    const draft=props.useInput(s=>s.draft),state=useSyncExternalStore(controller.subscribe,controller.snapshot);
    const known={...catalog,...Object.fromEntries(state.rows.map(m=>[m.id,m])),...Object.fromEntries(Object.values(state.cache).map(d=>[d.machine.id,d.machine]))};
    const chips=resolvedMentions(draft,known);
    return chips.length?<div className="mm-chips" data-machine-chips-dock>{chips.map(({id,name})=><span className="mm-chip" key={id}><button title="打开机器档案" onClick={()=>{toggle(true);window.dispatchEvent(new CustomEvent('machine-select',{detail:id}));}}>@ {name}</button><button aria-label={`移除机器引用：${id}`} onClick={()=>props.inputActions.setDraft(removeMention(draft,id))}>×</button></span>)}</div>:null;
  }
  function Networks({state}){return <div className="mm-networks"><h2>虚拟网络</h2><p className="mm-muted">本机 libvirt · 只读状态</p>{state.errors.networks&&<p role="alert">{state.errors.networks}</p>}{state.networks?.networks?.map(n=><article className="mm-connection" key={n.name}><div className="mm-row"><strong>{n.name}</strong><span className="mm-badge">{n.active?'运行中':'已停止'}</span></div><dl>{Object.entries(n).filter(([k])=>!['name','active','diagnostics'].includes(k)).map(([k,v])=><React.Fragment key={k}><dt>{({bridge:'网桥',forwardMode:'转发方式',addresses:'地址',dhcpRanges:'DHCP 范围',dhcpEnabled:'DHCP',persistent:'持久化',autostart:'自动启动',connections:'连接数'})[k]||k}</dt><dd><NetworkValue name={k} value={v}/></dd></React.Fragment>)}</dl></article>)}{state.networks?.diagnostics?.map((d,i)=><p className="mm-muted" key={i}>{d.message}</p>)}{!state.networks&&<p>正在读取网络…</p>}</div>;}
  function Panel(props) {
    const open=useOpen(), [rows,setRows]=useState([]),[query,setQuery]=useState(''),[archived,setArchived]=useState(false),[data,setData]=useState(null),[mode,setMode]=useState('view'),[tab,setTab]=useState('notes'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirm,setConfirm]=useState(false),[historyQuery,setHistoryQuery]=useState('');
    const panel=useRef(),seq=useRef(0),selected=useRef(null);
    const state=useSyncExternalStore(controller.subscribe,controller.snapshot),[resource,setResource]=useState('machines'),[filter,setFilter]=useState('all'),[width,setWidth]=useState(()=>{try{return Math.min(window.innerWidth,Math.max(480,Number(localStorage.getItem('machine-panel-width'))||760));}catch{return 760;}}),[historyOffset,setHistoryOffset]=useState(0),[attached,setAttached]=useState([]);
    const drag=useRef(null),modeRef=useRef(mode);modeRef.current=mode;
    const resize=value=>{const n=Math.max(Math.min(480,window.innerWidth),Math.min(960,window.innerWidth,value));setWidth(n);try{localStorage.setItem('machine-panel-width',String(n));}catch{}};
    useEffect(()=>{const fn=()=>{let preferred=760;try{preferred=Number(localStorage.getItem('machine-panel-width'))||760;}catch{}setWidth(Math.min(window.innerWidth,Math.max(480,Math.min(960,preferred))));};window.addEventListener('resize',fn);return()=>window.removeEventListener('resize',fn);},[]);
    useEffect(()=>{setRows(state.rows);if(selected.current&&state.cache[selected.current]&&modeRef.current==='view'&&tab!=='history')setData(state.cache[selected.current]);},[state]);
    useEffect(()=>{const sync=()=>{const main=Object.values(ctx.sessions.list.getSnapshot().byId).find(s=>(s.retainedBy.mainView??0)>0);if(!main){setAttached([]);return()=>{};}const input=ctx.conversation.input.for(ctx.sessions.scope(main.id));const update=()=>setAttached(mentions(input.state.getSnapshot().draft));update();return input.state.subscribe(update);};let dispose=sync();const unsub=ctx.sessions.list.subscribe(()=>{dispose?.();dispose=sync();});return()=>{dispose?.();unsub();};},[]);
    const list=async()=>{const r=await api.list({archived});controller.set({rows:r.machines});if(r.errors.length)setError(r.errors.map(x=>`${x.id}: ${x.error}`).join('\n'));};
    useEffect(()=>{if(open)controller.refresh(archived,true);else{controller.close();seq.current++;}},[open,archived]);
    const [pendingAction,setPendingAction]=useState(null);
    const editing=['edit','create'].includes(mode);
    const guard=action=>{if(editing)setPendingAction(()=>action);else action();};
    const close=()=>toggle(false);
    useEffect(()=>{mayClose=()=>{if(editing){setPendingAction(()=>()=>toggle(false));return false;}return true;};return()=>{mayClose=()=>true;};},[editing]);
    useEffect(()=>{if(!open)return;const key=e=>{if(e.key==='Escape'&&panel.current?.contains(e.target)&&!busy){e.stopPropagation();close();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[open,busy,mode]);
    useEffect(()=>{const fn=e=>guard(()=>{setResource('machines');select(e.detail);});window.addEventListener('machine-select',fn);return()=>window.removeEventListener('machine-select',fn);},[mode]);
    async function select(machineId,opts={}) {
      const token=++seq.current;selected.current=machineId;setError('');setNotice('');setMode('view');setConfirm(false);setData(controller.state.cache[machineId]??null);
      if(opts.refresh)controller.set({pending:{...controller.state.pending,[machineId]:true}});
      try{const d=opts.refresh?await api.refresh({machine_id:machineId,path_id:opts.path_id}):await api.inspect({machine_id:machineId,...opts});
        if(token===seq.current){setData(d);if(!opts.query&&!opts.offset)controller.remember(d);}
      }catch(e){if(token===seq.current){if(opts.refresh)controller.set({errors:{...controller.state.errors,[machineId]:e.message}});else setError(e.message);}}
      finally{if(opts.refresh)controller.set({pending:{...controller.state.pending,[machineId]:false}});}
    }
    async function save(values){setBusy(true);setError('');controller.close();try{const r=await api.manage({action:mode==='create'?'create':'update',...(mode==='create'?{}:{machine_id:data.machine.id,revision:data.revision}),...values});setTab('notes');await list();await select(r.id);setNotice('档案已保存');}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function archive(){setBusy(true);setError('');controller.close();try{await api.manage({action:data.machine.archived?'restore':'archive',machine_id:data.machine.id,revision:data.revision});await list();setData(null);selected.current=null;setConfirm(false);setNotice(data.machine.archived?'已恢复纳管':'已归档，所有记录保留');}catch(e){setError(e.message);}finally{setBusy(false);}}
    async function attach(machineId=data.machine.id){try{const mention=`@machine:${machineId}`;const main=Object.values(ctx.sessions.list.getSnapshot().byId).filter(s=>(s.retainedBy.mainView??0)>0);const sid=main.length===1?main[0].id:null;const scope=sid?ctx.sessions.scope(sid):null;if(scope){const input=ctx.conversation.input.for(scope);const draft=input.state.getSnapshot().draft;input.setDraft(mentions(draft).includes(machineId)?removeMention(draft,machineId):`${draft}${draft&&!/\s$/.test(draft)?' ':''}${mention} `);}else{await navigator.clipboard.writeText(mention);setNotice('机器引用已复制');}}catch(e){setError(e.message);}}
    if(!open)return null;
    const filtered=rows.filter(m=>JSON.stringify([m.name,m.id,m.aliases,m.purpose,m.host]).toLowerCase().includes(query.toLowerCase())&&(filter==='all'||machineStatus(state.cache[m.id])===filter));
    return <div className="mm-overlay"><section className="mm-panel" style={{width}} data-narrow={width<720} ref={panel} tabIndex={-1} role="dialog" aria-label="机器档案">
      <div className="mm-resizer" role="separator" aria-label="调整机器面板宽度" aria-orientation="vertical" aria-valuemin={Math.min(480,window.innerWidth)} aria-valuemax={Math.min(960,window.innerWidth)} aria-valuenow={width} tabIndex={0} onKeyDown={e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();resize(width+(e.key==='ArrowLeft'?16:-16));}}} onPointerDown={e=>{if(e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,width};}} onPointerMove={e=>{if(drag.current)resize(drag.current.width+drag.current.x-e.clientX);}} onPointerUp={e=>{drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}} onPointerCancel={()=>{drag.current=null;}}/>
      <header className="mm-header"><div className="mm-heading"><Icon size={20}/><h2>机器</h2><nav className="mm-resource"><button aria-pressed={resource==='machines'} onClick={()=>setResource('machines')}>档案</button><button aria-pressed={resource==='networks'} onClick={()=>guard(()=>setResource('networks'))}>网络</button></nav></div><div className="mm-row"><IconButton label="刷新全部状态" busy={state.loading} onClick={()=>controller.refresh(archived)}/><IconButton label="关闭机器档案" icon="close" disabled={busy} onClick={close}/></div></header>
      {pendingAction&&<div className="mm-discard" role="alertdialog" aria-label="放弃未保存的编辑"><p>放弃尚未保存的编辑？</p><div className="mm-actions"><button onClick={()=>setPendingAction(null)}>继续编辑</button><button onClick={()=>{const action=pendingAction;mayClose=()=>true;setMode('view');setPendingAction(null);action();}}>放弃修改</button></div></div>}
      {state.errors.directory&&<div role="alert" className="mm-error">{state.errors.directory} · 保留上次结果</div>}
      {resource==='networks'?<Networks state={state}/>:<>
      <div className="mm-layout" data-detail={Boolean(data)||mode==='create'}>
        <aside className="mm-sidebar"><button className="mm-add" disabled={busy} onClick={()=>guard(()=>{selected.current=null;setMode('create');setData(null);setError('');setNotice('');})}><Icon name="plus"/>登记机器</button><input className="mm-search" aria-label="搜索机器" placeholder="搜索名称、地址或别名…" value={query} onChange={e=>setQuery(e.target.value)}/><div className="mm-filters">{[false,true].map(value=><button key={String(value)} aria-pressed={archived===value} onClick={()=>guard(()=>{setArchived(value);selected.current=null;setData(null);setMode('view');setFilter('all');})}>{value?'已归档':'已纳管'}</button>)}</div><div className="mm-status-filters">{[['all','全部'],['reachable','可达'],['attention','异常'],['unknown','未检测']].map(([value,label])=><button key={value} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><div className="mm-list">{filtered.map(m=><div className="mm-list-row" key={m.id} data-selected={data?.machine.id===m.id}><button className="mm-item" aria-current={data?.machine.id===m.id?'true':undefined} onClick={()=>guard(()=>{setTab('notes');setHistoryQuery('');setHistoryOffset(0);select(m.id);})}><span className={'mm-dot '+(state.errors[m.id]?'attention':machineStatus(state.cache[m.id]))+(state.pending[m.id]?' pending':'')} role="img" aria-label={machineTooltip(state.cache[m.id],state.pending[m.id],state.errors[m.id])} title={machineTooltip(state.cache[m.id],state.pending[m.id],state.errors[m.id])}/><span className="mm-item-text"><strong>{m.name}</strong><small>{m.host||m.purpose||'尚未配置 SSH'}</small></span></button><button className="mm-mention" aria-label={`引用到对话：${m.name}`} aria-pressed={attached.includes(m.id)} title="引用到对话" onClick={()=>attach(m.id)}>＠</button></div>)}{!filtered.length&&<div className="mm-empty-small">{archived?'没有归档的机器':'没有匹配的机器'}</div>}</div><div className="mm-sidebar-foot">{rows.length} 台机器{state.loading?' · 正在刷新…':''}</div></aside>
        <main className="mm-main"><button className="mm-back" onClick={()=>guard(()=>{selected.current=null;seq.current++;setData(null);setMode('view');})}><Icon name="back" size={14}/>机器列表</button>
          {error&&<div role="alert" className="mm-error">{error}</div>}{notice&&<div role="status" className="mm-notice">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>}
          {mode==='create'||mode==='edit'?<Editor key={mode+data?.machine.id} data={mode==='edit'?data:null} onSave={save} busy={busy} onCancel={()=>guard(()=>setMode('view'))}/>:data?<>
            <div className="mm-detail-head"><div>{data.machine.archived&&<span className="mm-badge">已归档</span>}<h2>{data.machine.name}</h2><Purpose key={data.machine.id} value={data.machine.purpose}/></div><div className="mm-row"><button disabled={busy} onClick={()=>setMode('edit')}>编辑</button><button className="mm-mention" aria-label={`引用当前机器：${data.machine.name}`} aria-pressed={attached.includes(data.machine.id)} title="引用到对话" onClick={()=>attach()}>＠</button></div></div>
            <Connections key={`connections:${data.machine.id}`} data={data} pending={Boolean(state.pending[data.machine.id])} busy={busy} onRefresh={id=>select(data.machine.id,{refresh:true,path_id:id})} onEdit={()=>setMode("edit")}/>
            {data.virtualMachine&&<details className="mm-vm"><summary>虚拟机信息</summary><p className="mm-muted">{data.virtualMachine.summary}</p><dl>{data.virtualMachine.facts?.map((f,i)=><React.Fragment key={i}><dt>{f.label??f.key}</dt><dd>{String(f.value)}</dd></React.Fragment>)}</dl></details>}
            <section className="mm-apps-primary" aria-label="机器应用">{props.renderSlot?.('machine.detail.apps',{machineId:data.machine.id,openKey:state.openKey,refreshKey:state.refreshKey})}</section>
            <div className="mm-secondary" key={`secondary:${data.machine.id}`}>
              <details><summary>机器说明</summary><section className="mm-notes">{data.notes?<Text value={data.notes}/>:<div className="mm-empty-small">暂无说明</div>}</section></details>
              <details onToggle={e=>{if(e.currentTarget.open){setTab('history');setHistoryOffset(0);select(data.machine.id,{query:historyQuery,offset:0,limit:10});}else setTab('notes');}}><summary>历史记录</summary><section className="mm-history"><form className="mm-history-search" onSubmit={e=>{e.preventDefault();setHistoryOffset(0);select(data.machine.id,{query:historyQuery,offset:0,limit:10});}}><input aria-label="搜索历史" placeholder="查找历史中的关键词…" value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)}/><button disabled={busy}>搜索</button></form>{data.history.map((entry,i)=><article key={i}><Text value={entry}/></article>)}{!data.history.length&&<p className="mm-muted">没有匹配的历史记录。</p>}<div className="mm-row"><small className="mm-muted">共 {data.historyTotal} 条匹配记录</small>{historyOffset>0&&<button onClick={()=>{const offset=Math.max(0,historyOffset-10);setHistoryOffset(offset);select(data.machine.id,{query:historyQuery,offset,limit:10});}}>较新记录</button>}{data.nextOffset!==null&&<button disabled={busy} onClick={()=>{setHistoryOffset(data.nextOffset);select(data.machine.id,{query:historyQuery,offset:data.nextOffset,limit:10});}}>更早记录</button>}</div></section></details>
            </div>
            <footer className="mm-detail-footer"><button className="mm-link" disabled={busy} onClick={()=>setConfirm(!confirm)}>{data.machine.archived?'恢复纳管':'移出纳管'}</button></footer>{confirm&&<div className="mm-confirm"><p>{data.machine.archived?'恢复到机器列表，并重新生成 SSH 配置。':'移出列表并停用生成的 SSH 配置。档案和历史保留，不影响远端机器。'}</p><div className="mm-actions"><button onClick={()=>setConfirm(false)}>取消</button><button disabled={busy} onClick={archive}>{data.machine.archived?'确认恢复':'确认归档'}</button></div></div>}
          </>:<div className="mm-welcome"><span className="mm-symbol"><Icon size={32}/></span><p>选择一台机器</p></div>}
        </main>
      </div></>}</section></div>;
  }
  ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'machine-mgmt',label:'机器档案'},p=><Boundary><Footer {...p}/></Boundary>));
  ctx.slots.inject('conversation.input.dock',()=>ctx.slots.register({name:'conversation.input.dock',id:'machine-chips',order:30},p=><Boundary><Dock {...p}/></Boundary>));
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'machine-management',order:20,label:'机器'},()=> <div><h3>机器档案</h3><p>连接、当前说明与重要历史保存在机器目录中。</p><button onClick={()=>toggle(true)}>打开机器面板</button></div>));
  ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'machine-mgmt-workbench',children:{'machine.detail.apps':{kind:'list',scope:'root'}}},p=><Boundary><Panel {...p}/></Boundary>));
  return dispose;
}
