import {createServer} from 'node:http'
import {readFileSync} from 'node:fs'
import {DynamicExtensions,registerExtensionRoutes} from '../src/extensions/dynamic-host.ts'
const store=new DynamicExtensions('/tmp/app-cards-dynamic/qa-data/extensions');let handler:any
registerExtensionRoutes({inject:(_keys:any,fn:any)=>fn({connection:{admit:()=>({peer:{}})},effect:(fn:any)=>fn(),webServer:{register:(r:any)=>{handler=r.handler;return ()=>{}}}})},store)
createServer((req,res)=>{
 if(req.url?.startsWith('/app-card-extensions/')){handler(req,res);return}
 if(req.url==='/preview.js'){res.setHeader('Content-Type','text/javascript');res.end(readFileSync('preview/dynamic.js'));return}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>独立扩展验收</title><body style="margin:0;background:#161616;color:#eee"><div id="root"></div><script src="/preview.js"></script></body>')
}).listen(3099,'127.0.0.1',()=>console.log('QA_PID='+process.pid))
