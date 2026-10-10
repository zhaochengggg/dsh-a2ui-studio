import {readFile,stat} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]);
const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
assert.equal(manifest.name,'dsh-machine-apps');
const plugin=await import(pathToFileURL(join(root,'index.mjs')));
const registrations=[],modules=[];
await plugin.apply({plugin:(p,c)=>modules.push({p,c}),skills:{register:r=>registrations.push(r)}},{dataRoot:'/srv/custom-home',appCards:{hostRoots:['/srv/work'],concurrency:2}});
assert.equal(modules[0].c.root,'/srv/custom-home/machines');assert.equal(modules[1].c.dataPath,'/srv/custom-home/app-cards');assert.equal(modules[1].c.concurrency,2);
const {registerPackagedSkill}=await import(pathToFileURL(join(root,'apps/lib/maintenance.js')));
await registerPackagedSkill({skills:{register:r=>registrations.push(r)}});
for(const r of registrations){assert.ok(!relative(root,r.path).startsWith('..'));await stat(r.path);const seen=new Set();async function walk(p){if(seen.has(p))return;seen.add(p);const body=await readFile(p,'utf8');for(const m of body.matchAll(/\]\(([^)]+\.md)\)/g))if(!m[1].includes('://'))await walk(resolve(p,'..',m[1]));}await walk(r.path);}
const {default:remote}=await import(pathToFileURL(join(root,'lib/remote.js')));assert.equal(remote.package,'dsh-machine-apps');assert.equal(remote.descriptors.length,12);assert.equal(new Set(remote.descriptors.map(x=>x.id)).size,12);
assert.equal(registrations.length,3);console.log('Installed tarball: native imports, 2 modules, 3 skills and references, 12 remote methods OK.');
