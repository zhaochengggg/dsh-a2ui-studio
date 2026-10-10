import React from 'react';
export function Icon({name='server',size=16}:{name?:string,size?:number}) {
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{name==='refresh'?<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></>:name==='close'?<path d="m6 6 12 12M18 6 6 18"/>:name==='plus'?<path d="M12 5v14M5 12h14"/>:name==='back'?<path d="m14 6-6 6 6 6"/>:<><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/></>}</svg>;
}
export function IconButton({label,icon='refresh',busy=false,disabled=false,onClick}:{label:string,icon?:string,busy?:boolean,disabled?:boolean,onClick:()=>void}) {
 return <button type="button" data-mgmt-icon-button="" title={label} aria-label={label} aria-busy={busy} disabled={disabled||busy} onClick={onClick}><Icon name={icon}/></button>;
}
