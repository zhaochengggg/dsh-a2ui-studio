import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('machine overlay uses the host chrome clearance without a web-only blank titlebar',async()=>{
 const css=await readFile(new URL('../machines/style.css',import.meta.url),'utf8');
 const overlay=css.match(/\.mm-overlay\{([^}]+)\}/)?.[1];
 assert.match(overlay,/inset:max\(var\(--dsh-frame-chrome-top,0px\),env\(titlebar-area-height,0px\)\) 0 0;/);
 assert.doesNotMatch(overlay,/height:100vh/);
 assert.match(css,/\.mm-panel\{[^}]*height:100%/);
});
