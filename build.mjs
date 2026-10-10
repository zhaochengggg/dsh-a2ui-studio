import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readFile,mkdir,readdir,writeFile,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('.',import.meta.url)));
const require=createRequire(import.meta.url);
const styles={name:'styles',setup(b){b.onLoad({filter:/\.module\.css$/},async args=>{
 const source=await readFile(args.path,'utf8'),names=[...new Set([...source.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(x=>x[1]))];
 const css=source.replace(/\.([a-zA-Z][\w-]*)/g,(_m,n)=>'.dsh-ac-'+n);
 return {loader:'js',contents:`export const text=${JSON.stringify(css)};export default ${JSON.stringify(Object.fromEntries(names.map(n=>[n,'dsh-ac-'+n])))};`};
});}};
const common={bundle:true,logLevel:'info',target:'es2022',external:['@deepseek-ai/*'],define:{__APP_CARDS_BUNDLED__:'true'}};
const node={...common,platform:'node',format:'esm',banner:{js:'import {createRequire as __nodeRequire} from "node:module";const require=__nodeRequire(import.meta.url);'}};
await mkdir('lib',{recursive:true});
await build({...node,entryPoints:['machines/observer-entry.ts'],outfile:'machines/lib/observers.mjs'});
await build({...node,entryPoints:['apps/src/index.ts'],outfile:'apps/lib/index.js'});
await build({...node,entryPoints:['apps/src/maintenance.ts'],outfile:'apps/lib/maintenance.js'});
await build({...node,external:[...node.external,'esbuild'],entryPoints:['apps/src/extensions/cli.ts'],outfile:'apps/lib/extensionctl.js'});
await build({entryPoints:[require.resolve('jsonata')],bundle:true,platform:'node',format:'cjs',outfile:'apps/lib/jsonata.cjs'});
await build({...node,entryPoints:['remote.ts'],outfile:'lib/remote.js'});
await build({...common,entryPoints:['client.ts'],outfile:'lib/client.js',format:'cjs',platform:'browser',plugins:[styles],loader:{'.css':'text'},jsx:'automatic',external:['react','react/jsx-runtime'],banner:{js:'window.__ModuleLoader__.load({id:"dsh-machine-apps",factory:(require)=>{var module={exports:{}};var exports=module.exports;'},footer:{js:'return module.exports;}});'}});
const hashes={};
async function collect(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=dir+'/'+e.name;if(e.isDirectory())await collect(p);else if(/\.(tsx?|css)$/.test(p))hashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');}}
await collect('apps/src');await collect('shared');
await writeFile('apps/lib/extension-manifest.json',JSON.stringify({format:1,sourceDigest:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),files:hashes},null,2)+'\n');
if(process.argv.includes('--preview')){
 await mkdir('preview',{recursive:true});
 await build({...common,entryPoints:['apps/tests/presentation-preview.tsx'],outfile:'preview/presentation.js',format:'iife',platform:'browser',plugins:[styles],loader:{'.css':'text'},jsx:'automatic',external:[]});
 await copyFile('apps/tests/presentation.html','preview/presentation.html');
 await writeFile('preview/machine.css',await readFile('machines/style.css','utf8')+'\n'+await readFile('shared/ui.css','utf8'));
}
