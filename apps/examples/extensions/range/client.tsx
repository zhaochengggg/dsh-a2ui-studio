import {RangeGauge} from 'app-cards/sdk'
function Meter({value,child,raw,fresh,ariaLabel}:any){
 return <div><RangeGauge label={String(value('label')??'')} value={value('value')} min={0} max={value('max')} marker={value('marker')} unit={value('unit')??''} fresh={fresh} ariaLabel={ariaLabel} colorScale="thermal"/>{raw.child?child(raw.child):null}</div>
}
export const components={'range-demo.v1.Meter':Meter}
