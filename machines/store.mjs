/** Text-only source of truth. All plugin readers and writers share an OS-level lock. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {discover,connect,parseKeys,classify,problem,limited} from './probe.mjs';
import {localSshPath,sshNullFile} from './ssh-paths.mjs';
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();
function fail(message) { throw new Error(message); }
function text(value, max = 20000) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) fail('Invalid or oversized text'); return value; }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('Invalid machine/path ID'); return value; }
async function read(file) { try { const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink() || st.size > 8 * 1024 * 1024) fail('Unsafe or oversized file'); return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
export async function atomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const h = await fs.open(temp, 'wx', 0o600);
  try { await h.writeFile(value); await h.sync(); } finally { await h.close(); }
  await fs.rename(temp, file);
}
export function validateMachine(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Machine must be an object');
  const allowed = ['version','id','name','purpose','aliases','connections','defaultConnection','archived','createdAt','updatedAt','locator'];
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) fail(`Unknown machine field: ${k}`);
  const m = { version: 1, id: id(raw.id), name: text(raw.name, 120).trim(), purpose: text(raw.purpose ?? '', 1000), aliases: raw.aliases ?? [], connections: raw.connections ?? [], archived: raw.archived ?? false, createdAt: raw.createdAt ?? stamp(), updatedAt: raw.updatedAt ?? stamp() };
  if (!m.name || typeof m.archived !== 'boolean') fail('Name/status invalid');
  if (!Array.isArray(m.aliases) || m.aliases.length > 32) fail('Invalid aliases');
  m.aliases = m.aliases.map(x => text(x, 120));
  if (!Array.isArray(m.connections) || m.connections.length > 16) fail('Invalid SSH connections');
  m.connections = m.connections.map(c => {
    for (const k of Object.keys(c)) if (!['id','host','port','user','identityFile','fingerprint','label'].includes(k)) fail(`Unknown connection field: ${k}`);
    const v = { id: id(c.id), host: text(c.host, 253), port: c.port ?? 22, user: text(c.user, 64), identityFile: text(c.identityFile ?? '', 1024), fingerprint: text(c.fingerprint ?? '', 128), label: text(c.label ?? '', 120) };
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.:%_-]*$/.test(v.host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(v.user)) fail('Invalid SSH host/user');
    if (!Number.isInteger(v.port) || v.port < 1 || v.port > 65535) fail('Invalid SSH port');
    if (v.identityFile) v.identityFile=localSshPath(v.identityFile);
    if (v.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(v.fingerprint)) fail('Expected SHA256 host-key fingerprint');
    return v;
  });
  if (new Set(m.connections.map(c => c.id)).size !== m.connections.length) fail('Duplicate connection ID');
  if (raw.defaultConnection && m.connections.length) { m.defaultConnection = id(raw.defaultConnection); if (!m.connections.some(c => c.id === m.defaultConnection)) fail('Default connection not found'); }
  else if (m.connections.length) m.defaultConnection = m.connections[0].id;
  if (raw.locator !== undefined) { text(JSON.stringify(raw.locator), 4000); m.locator = raw.locator; }
  return m;
}
export class MachineStore {
  constructor(root, sshDir) { this.root = path.resolve(root); this.sshDir = path.resolve(sshDir); this.observations = new Map(); this.probes = new Map(); }
  async locked(fn) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = path.join(this.root, '.lock');
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const owner=Number((await read(path.join(lock,'owner'))).trim());
          if(Number.isSafeInteger(owner)&&owner>0){try{process.kill(owner,0);}catch(err){if(err.code==='ESRCH'){const st=await fs.lstat(lock);if(st.isDirectory()&&!st.isSymbolicLink())await fs.rm(lock,{recursive:true});continue;}}}
        } catch(err){if(err.code!=='ENOENT')throw err;}
        if (Date.now() > deadline) fail('Machine directory busy. Inspect .lock owner before recovery.'); await new Promise(r => setTimeout(r, 30));
      }
    }
    try { await fs.writeFile(path.join(lock, 'owner'), `${process.pid}\n`, {mode: 0o600}); await this.recover(); return await fn(); }
    finally { await fs.rm(lock, {recursive: true}); }
  }
  async recover() {
    const file = path.join(this.root, '.pending.json'), pending = await read(file);
    if (!pending) return;
    const p = JSON.parse(pending); const dir = await this.dir(p.id, true);
    for (const name of ['machine.json','notes.md','history.md']) if (typeof p.files[name] === 'string') await atomic(path.join(dir, name), p.files[name]);
    await fs.unlink(file);
  }
  async dir(machineId, create = false) {
    const dir = path.join(this.root, id(machineId));
    if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(dir); if (!st.isDirectory() || st.isSymbolicLink()) fail('Unsafe machine directory');
    return dir;
  }
  async load(machineId) {
    const dir = await this.dir(machineId), raw = await read(path.join(dir, 'machine.json'));
    const machine = validateMachine(JSON.parse(raw)); if (machine.id !== machineId) fail('Machine ID does not match directory');
    const notes = await read(path.join(dir, 'notes.md')), history = await read(path.join(dir, 'history.md'));
    return {machine, notes, history, revision: hash(raw + '\0' + notes + '\0' + history)};
  }
  async all() {
    const result = [], errors = [];
    for (const entry of await fs.readdir(this.root, {withFileTypes: true})) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      try { result.push(await this.load(entry.name)); } catch(e) { errors.push({id: entry.name, error: e.message}); }
    }
    return {result, errors};
  }
  async list(args = {}) { return this.locked(async () => {
    const {result, errors} = await this.all(); const q = String(args.query ?? '').toLowerCase();
    const machines = result.filter(x => (args.archived ? x.machine.archived : !x.machine.archived) && JSON.stringify([x.machine.id,x.machine.name,x.machine.aliases,x.machine.purpose]).toLowerCase().includes(q)).map(({machine:m}) => ({id:m.id,name:m.name,purpose:m.purpose,aliases:m.aliases,archived:m.archived,connectionCount:m.connections.length,host:m.connections.find(c=>c.id===m.defaultConnection)?.host ?? null}));
    return {machines, errors};
  }); }
  async inspect(args) {
    const data = await this.locked(() => this.load(args.machine_id));
    if (args.refresh) {
      if (data.machine.archived) fail('Archived machines cannot be probed');
      const c = data.machine.connections.find(c => c.id === (args.path_id ?? data.machine.defaultConnection));
      if (!c) fail('No SSH connection selected');
      await this.probe(data.machine, c);
      return this.inspect({...args,refresh:false});
    }
    const lines = data.history.split('\n'); const query = String(args.query ?? '').toLowerCase();
    const entries = data.history.split(/(?=^## )/m).filter(x=>x.trim()).reverse().filter(x=>!query || x.toLowerCase().includes(query));
    const offset = Math.max(0, Math.trunc(args.offset ?? 0)), limit = Math.min(30, Math.max(1, Math.trunc(args.limit ?? 5)));
    return {machine:data.machine,notes:data.notes,revision:data.revision,history:entries.slice(offset,offset+limit).map(x=>x.slice(0,12000)),historyTotal:entries.length,nextOffset:offset+limit<entries.length ? offset+limit:null,
      connections:data.machine.connections.map(c=>({...c,command:['ssh','-F',path.join(this.sshDir,'config'),`dsh-${data.machine.id}-${c.id}`],observation:this.observations.get(`${data.machine.id}/${c.id}`) ?? null})), files:{directory:path.join(this.root,data.machine.id),historyLines:lines.length}};
  }
  async manage(args) { return this.locked(async () => {
    const action = args.action;
    if (!['create','update','archive','restore'].includes(action)) fail('Unknown action');
    let old, m, notes, history, machineId;
    if (action === 'create') {
      machineId = args.machine_id || `machine-${randomUUID().slice(0,8)}`; id(machineId);
      try { await fs.lstat(path.join(this.root,machineId)); fail('Machine ID already exists (including archived)'); } catch(e) { if(e.code !== 'ENOENT') throw e; }
      m = validateMachine({...args.machine,id:machineId,archived:false,createdAt:stamp(),updatedAt:stamp()}); notes=text(args.notes ?? ''); history='';
    } else {
      machineId = id(args.machine_id); old = await this.load(machineId);
      if (!args.revision || args.revision !== old.revision) fail('Conflict: inspect the machine again and use its current revision');
      m = validateMachine({...old.machine,...(args.machine ?? {}),id:machineId,archived:old.machine.archived,createdAt:old.machine.createdAt,updatedAt:stamp()});
      notes=args.notes === undefined ? old.notes : text(args.notes); history=old.history;
      if(action==='archive') m.archived=true;
      if(action==='restore') m.archived=false;
    }
    if (args.machine && ['id','archived','createdAt','updatedAt','version'].some(k=>k in args.machine)) fail('Identity/status fields are managed by the operation');
    const {result,errors}=await this.all(); if(errors.length) fail('Repair invalid machine files before writing SSH configuration');
    if(!m.archived) for(const other of result) {
      if(other.machine.id===m.id || other.machine.archived) continue;
      for(const c of m.connections) if(other.machine.connections.some(d=>c.host.toLowerCase()===d.host.toLowerCase() && c.port===d.port && c.user===d.user && c.identityFile===d.identityFile)) fail(`Connection already registered to ${other.machine.id}`);
    }
    const defaultMessage = {create:'登记计算机。',archive:'移出纳管；保留档案。',restore:'恢复纳管。',update:'更新计算机资料。'}[action];
    const message=text(args.message ?? defaultMessage, 4000).trim();
    if(message) history += `${history.endsWith('\n') || !history ? '' : '\n'}## ${stamp()}\n\n${message}\n\n`;
    const files={'machine.json':JSON.stringify(m,null,2)+'\n','notes.md':notes,'history.md':history};
    // The durable intent is replayed after interruption; readers share this lock.
    const pending=JSON.stringify({id:machineId,files});
    if(Buffer.byteLength(pending)>7*1024*1024)fail('Machine archive too large; split older history into an explicitly linked text archive before updating');
    await atomic(path.join(this.root,'.pending.json'),pending);
    await this.recover();
    // Never present a previous endpoint's status after its declaration changed.
    for(const c of old?.machine.connections??[])if(m.archived||JSON.stringify(m.connections.find(n=>n.id===c.id))!==JSON.stringify(c))this.observations.delete(`${m.id}/${c.id}`);
    await this.project();
    return {id:machineId,archived:m.archived,revision:(await this.load(machineId)).revision};
  }); }
  async project() {
    await fs.mkdir(this.sshDir,{recursive:true,mode:0o700});
    const {result,errors}=await this.all(); if(errors.length) fail('Invalid machine files; SSH projection not updated');
    let config='# Generated from machine records; edit machine.json, not this file.\n';
    for(const {machine:m} of result) if(!m.archived) for(const c of m.connections) {
      config+=`\nHost dsh-${m.id}-${c.id}\n  HostName ${c.host}\n  Port ${c.port}\n  User ${c.user}\n  HostKeyAlias dsh-${m.id}-${c.id}\n  UserKnownHostsFile "${localSshPath(path.join(this.sshDir,'known_hosts'))}"\n  GlobalKnownHostsFile ${sshNullFile()}\n  StrictHostKeyChecking yes\n  BatchMode yes\n  ForwardAgent no\n  ForwardX11 no\n  ClearAllForwardings yes\n  PermitLocalCommand no\n  ProxyCommand none\n  ProxyJump none\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  ConnectTimeout 8\n`;
      if(c.identityFile) config+=`  IdentityFile "${c.identityFile}"\n  IdentitiesOnly yes\n`;
    }
    await atomic(path.join(this.sshDir,'config'),config);
  }
  async probe(m,c) {
    const key=`${m.id}/${c.id}`, signature=JSON.stringify(c), inflight=key+'\0'+signature;
    if(this.probes.has(inflight))return this.probes.get(inflight);
    const task=limited(async()=>{
      const result=await this.probeConnection(m,c);
      return this.locked(async()=>{
        const current=await this.load(m.id);
        if(current.machine.archived||JSON.stringify(current.machine.connections.find(x=>x.id===c.id))!==signature)
          throw problem('configuration_changed','连接配置已变化，已丢弃旧探测结果。');
        const previous=this.observations.get(key);
        result.lastSuccessAt=result.status==='reachable'?result.observedAt:previous?.lastSuccessAt;
        this.observations.set(key,result);return result;
      });
    });
    this.probes.set(inflight,task);try{return await task;}finally{this.probes.delete(inflight);}
  }
  async probeConnection(m,c) {
    const start=Date.now(),alias=`dsh-${m.id}-${c.id}`;let temp;
    try {
      if(!c.fingerprint)throw problem('identity_missing','未登记可信主机指纹；请先核验并填写。');
      const known=await read(path.join(this.sshDir,'known_hosts'));
      const lines=known.split('\n').filter(l=>l.split(/\s+/)[0]===alias);
      const keys=parseKeys(lines.join('\n'));
      let pin=keys.find(k=>k.fingerprint===c.fingerprint.replace(/=+$/,''));
      if(lines.length&&(!pin||keys.some(k=>k.fingerprint!==pin.fingerprint)))
        throw problem('pin_conflict','本地已登记公钥与可信指纹不一致；请核验登记配置。');
      const deadline=start+(pin?10000:12000);
      if(!pin) {
        pin=(await discover(c,{deadline:Math.min(start+6500,deadline)})).key;
        await this.locked(async()=>{
          const current=await this.load(m.id);
          if(current.machine.archived||JSON.stringify(current.machine.connections.find(x=>x.id===c.id))!==JSON.stringify(c))
            throw problem('configuration_changed','连接配置已变化，停止登记主机密钥。');
          const kh=path.join(this.sshDir,'known_hosts'),existing=await read(kh);
          const currentLines=existing.split('\n').filter(l=>l.split(/\s+/)[0]===alias);
          if(currentLines.length&&parseKeys(currentLines.join('\n')).some(k=>k.fingerprint!==pin.fingerprint))
            throw problem('pin_conflict','主机密钥记录在探测期间发生冲突。');
          await atomic(kh,existing.split('\n').filter(l=>l&&l.split(/\s+/)[0]!==alias).concat(`${alias} ${pin.type} ${pin.key}`).join('\n')+'\n');
        });
      }
      // Per-request immutable pin prevents concurrent edits of shared SSH projections changing trust.
      temp=await fs.mkdtemp(path.join(this.sshDir,'.probe-'));
      const kh=path.join(temp,'known_hosts');await fs.writeFile(kh,`${alias} ${pin.type} ${pin.key}\n`,{mode:0o600});
      const value=await connect(c,alias,kh,pin,{deadline});
      return {status:'reachable',code:'ok',observedAt:stamp(),durationMs:Date.now()-start,...value};
    }catch(e){const failure=classify(e);return {status:failure.code==='execution_failed'?'execution_failed':'unreachable',...failure,observedAt:stamp(),durationMs:Date.now()-start,attempts:e.attempts,evidence:e.evidence};}
    finally{if(temp)await fs.rm(temp,{recursive:true,force:true});}
  }
}
