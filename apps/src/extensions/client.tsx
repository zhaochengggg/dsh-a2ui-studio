import {Component,type ReactNode} from 'react'
import {TelemetryGauge} from './telemetry/client.tsx'
import {installedApis} from './installed.ts'
export interface ExtensionViewProps {value:(name:string)=>unknown;has:(name:string)=>boolean;child:(node:unknown)=>ReactNode;raw:Record<string,unknown>;fresh:boolean;ariaLabel?:string}
export const extensionViews:Record<string,(p:ExtensionViewProps)=>ReactNode>={
 'telemetry.v1.Gauge':TelemetryGauge,
}
export function validateExtensionViews(){const names=installedApis.map(c=>c.name);if(names.length!==Object.keys(extensionViews).length||names.some(n=>!extensionViews[n]))throw Error('Extension schema/renderer mismatch')}
validateExtensionViews()
export class ExtensionBoundary extends Component<{children:ReactNode},{error:boolean}>{
 state={error:false};static getDerivedStateFromError(){return {error:true}}
 render(){return this.state.error?<span role="alert">扩展组件显示失败，其他卡片仍可使用。</span>:this.props.children}
}
