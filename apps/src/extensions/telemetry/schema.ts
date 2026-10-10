import {z} from 'zod/v3'
import {visualNumber,visualText,visualBoolean,visualFields} from '../../visual-schema.ts'
import type {ExtensionPackage} from '../registry.ts'
import {uiCommon} from '../../ui-functions.ts'
export const telemetry:ExtensionPackage={id:'telemetry.v1',version:'1.0.0',description:'Continuous range gauges with independent setpoint markers; values remain visible when out of range.',components:[{
 name:'telemetry.v1.Gauge',schema:z.object({...uiCommon,...visualFields,variant:z.enum(['compact','detailed']).optional(),label:visualText,value:visualNumber,min:visualNumber.optional(),max:visualNumber,marker:visualNumber.optional(),unit:visualText.optional(),accessibility:z.object({label:visualText.optional(),description:visualText.optional()}).strict().optional()}).strict()
}]}
