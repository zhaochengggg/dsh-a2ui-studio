import {z} from 'zod/v3'
import {uiNumber,uiBoolean,uiText} from './ui-functions.ts'
export const visualNumber=uiNumber
export const visualBoolean=uiBoolean
export const visualText=uiText
export const visualFields={
  colorScale:z.enum(['thermal','reverse-thermal']).optional(),
  colorValue:visualNumber.optional(),colorMin:visualNumber.optional(),colorMax:visualNumber.optional(),
  fresh:visualBoolean.optional(),
}
