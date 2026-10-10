import {ratio,scaleColor} from './color-scale.ts'
import css from './app-cards.module.css'
export function RangeGauge({value,min=0,max,marker,label,unit='',fresh=true,colorScale,colorValue,colorMin,colorMax,ariaLabel,compact=true,role='meter'}:{value:unknown;min?:unknown;max?:unknown;marker?:unknown;label:string;unit?:string;fresh?:boolean;colorScale?:unknown;colorValue?:unknown;colorMin?:unknown;colorMax?:unknown;ariaLabel?:string;compact?:boolean;role?:'meter'|'progressbar'}){
 const t=fresh?ratio(value,min,max):null,m=ratio(marker,min,max)
 const color=t===null?undefined:colorScale?scaleColor(colorValue===undefined?value:colorValue,colorMin===undefined?min:colorMin,colorMax===undefined?max:colorMax,colorScale==='reverse-thermal'):undefined
 const numeric=typeof value==='number'&&Number.isFinite(value)
 const status=!fresh?'观测已过期':t===null?'暂无观测或有效量程':''
 const bound=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?String(v):'—'
 const reading=`${numeric?value:'—'} / ${bound(max)}${unit?` ${unit}`:''}`
 const rangeText=`量程 ${bound(min)}–${bound(max)}${unit?` ${unit}`:''}${m!==null?`；设定 ${marker} ${unit}`:''}`
 return <div className={css.gauge} data-compact={compact} data-quality={!fresh?'stale':t===null?'unknown':'current'}>
  <div className={css.gaugeLabel}><span>{label}</span><span className={css.reading}>{numeric?value:'—'} / {bound(max)}{unit&&<small> {unit}</small>}</span></div>
  <div className={css.gaugeTrack} title={rangeText} role={t===null?(role==='progressbar'?role:'img'):role} aria-label={ariaLabel??label} aria-valuemin={t!==null&&typeof min==='number'?min:undefined} aria-valuemax={t!==null&&typeof max==='number'?max:undefined} aria-valuenow={t===null?undefined:Math.max(Number(min),Math.min(Number(max),Number(value)))} aria-valuetext={status||`${reading}；${rangeText}`}>
    {t!==null&&<span className={css.gaugeFill} style={{width:`${t*100}%`,backgroundColor:color}}/>}
    {m!==null&&<span className={css.gaugeMarker} style={{left:`${m*100}%`}} title={`设定值 ${marker} ${unit}`}/>}
  </div>
  {status&&<span className={css.gaugeStatus}>{status}</span>}
 </div>
}
