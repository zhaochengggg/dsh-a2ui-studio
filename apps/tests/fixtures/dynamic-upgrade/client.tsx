import {RangeGauge} from 'app-cards/sdk'
function Meter({value,child,raw,fresh}:any){return <div><RangeGauge label={value('label')} value={value('value')} min={0} max={value('max')} marker={value('marker')} unit={value('unit')} fresh={fresh} colorScale="thermal"/><small>扩展 1.0.1 的新代码已生效</small>{raw.child?child(raw.child):null}</div>}
export const components={'range-demo.v1.Meter':Meter}
