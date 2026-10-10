// Load the actual published client module using its public module-loader wrapper.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url);let exports;
runInNewContext(readFileSync(require.resolve('@deepseek-ai/dsh-api-gateway/client'),'utf8'),{
 window:{__ModuleLoader__:{load:entry=>{exports=entry.factory(require);}}},
 console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController,AbortSignal,DOMException,Error,TypeError,TextEncoder,TextDecoder,URL,fetch,
});
export const {RemoteStream,RemoteStreamCarrierError}=exports;
