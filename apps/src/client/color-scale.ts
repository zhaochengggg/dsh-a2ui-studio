// Equal segments in OKLab: perceptually continuous, no threshold bands.
const stops=[[.62,-.03,-.16],[.72,-.15,.09],[.86,-.02,.16],[.62,.20,.11]]
export function ratio(value:unknown,min:unknown,max:unknown):number|null {
 if(typeof value!=='number'||typeof min!=='number'||typeof max!=='number'||![value,min,max].every(Number.isFinite)||max<=min)return null
 return Math.max(0,Math.min(1,(value-min)/(max-min)))
}
export function scaleColor(value:unknown,min:unknown,max:unknown,reverse=false):string|undefined {
 let t=ratio(value,min,max);if(t===null)return undefined;if(reverse)t=1-t
 const p=t*3,i=Math.min(2,Math.floor(p)),f=p-i
 const [l,a,b]=stops[i].map((n,k)=>n+(stops[i+1][k]-n)*f)
 const x=(l+.3963377774*a+.2158037573*b)**3,y=(l-.1055613458*a-.0638541728*b)**3,z=(l-.0894841775*a-1.291485548*b)**3
 const rgb=[4.0767416621*x-3.3077115913*y+.2309699292*z,-1.2684380046*x+2.6097574011*y-.3413193965*z,-.0041960863*x-.7034186147*y+1.707614701*z].map(c=>Math.round(255*Math.max(0,Math.min(1,c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055))))
 return `rgb(${rgb.join(', ')})`
}
