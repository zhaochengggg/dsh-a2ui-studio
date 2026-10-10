import {RangeGauge} from '../../client/range-gauge.tsx'
import type {ExtensionViewProps} from '../client.tsx'
export function TelemetryGauge({value,has,fresh,ariaLabel}:ExtensionViewProps){
 const limit=(k:string,f:unknown)=>!has(k)?f:value(k)??null
 return <RangeGauge compact={value('variant')!=='detailed'} label={String(value('label')??'')} value={value('value')} min={limit('min',0)} max={value('max')} marker={value('marker')} unit={String(value('unit')??'')} fresh={fresh} colorScale={value('colorScale')??'thermal'} colorValue={limit('colorValue',undefined)} colorMin={limit('colorMin',undefined)} colorMax={limit('colorMax',undefined)} ariaLabel={ariaLabel}/>
}
