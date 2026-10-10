/** React-free A2UI catalog and declaration validation shared by Host and Client. @module */

import {
  ActionSchema,
  CardApi,
  Catalog,
  CheckBoxApi,
  ChoicePickerApi,
  ColumnApi,
  DataBindingSchema,
  DividerApi,
  DynamicBooleanSchema,
  DynamicStringListSchema,
  DynamicStringSchema,
  DynamicValueSchema,
  ListApi,
  RowApi,
  TabsApi,
  TextApi,
  TextFieldApi,
  componentId,
  extractRefFields,
  type ComponentApi,
} from '@a2ui/web_core/v0_9'
import { z } from 'zod/v3'
import {previewScenariosSchema,previewSnapshot} from './preview.ts'
import type { CardDeclaration, JsonValue } from './types.ts'
import {visualFields,visualNumber,visualBoolean,visualText} from './visual-schema.ts'
import {installedExtensions} from './extensions/installed.ts'
import {extensionApis} from './extensions/registry.ts'
import {dynamicPackages} from './extensions/dynamic-schema.ts'
import {uiPath,uiCall,uiBoolean,uiNumber,uiText,uiValue,uiCommon,uiFunctions,validateUiExpressions} from './ui-functions.ts'

/** Catalog identity accepted by application declarations. */
export const APP_CATALOG_ID = 'urn:dsh:app-cards:catalog:1'

const path = DataBindingSchema.strict().extend({
  path: z.string().refine(validPath, 'Invalid or unsafe data path'),
})
const text = uiText
const boolean = uiBoolean
const strings = z.union([z.array(z.string()), path,uiCall]).describe(DynamicStringListSchema.description ?? '')
const dynamic = uiValue
const action = z.union([
  z.object({
    event: z.object({
      name: z.literal('app.invoke'),
      context: z.object({ actionId: z.string().min(1), input: dynamic }).strict(),
    }).strict(),
  }).strict(),
  z.never(),
]).describe(ActionSchema.description ?? '')
const accessibility = z.object({ label: text.optional(), description: text.optional() }).strict()
const common = { accessibility: accessibility.optional(), ...uiCommon }
const number = uiNumber
const base = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => {
  const { weight: _weight, accessibility: _accessibility, ...shape } = schema.shape
  return z.object(shape).extend(common).strict()
}

const apis: ComponentApi[] = [
  { name: 'Row', schema: base(RowApi.schema) },
  { name: 'Grid', schema: base(RowApi.schema).extend({columns:z.number().int().min(1).max(6).optional()}) },
  { name: 'Column', schema: base(ColumnApi.schema) },
  { name: 'Card', schema: base(CardApi.schema).extend({...visualFields,warning:visualBoolean.optional(),warningText:visualText.optional()}) },
  { name: 'List', schema: base(ListApi.schema) },
  { name: 'Tabs', schema: base(TabsApi.schema).extend({
    tabs: z.array(z.object({ title: text, child: componentId() }).strict()).min(1),
  }) },
  { name: 'Disclosure', schema: z.object({ ...common, title: text, child: componentId() }).strict() },
  { name: 'Text', schema: base(TextApi.schema).extend({ text }) },
  { name: 'Icon', schema: z.object({
    ...common, name: z.enum(['info', 'check', 'warning', 'error', 'play', 'stop', 'refresh']),
  }).strict() },
  { name: 'Divider', schema: base(DividerApi.schema) },
  { name: 'Table', schema: z.object({
    ...common,
    columns: z.array(z.object({ title: text, key: z.string().min(1) }).strict()).min(1),
    rows: z.union([z.array(z.record(z.unknown())), path]).describe(DynamicValueSchema.description ?? ''),
  }).strict() },
  { name: 'CodeBlock', schema: z.object({ ...common, text, language: z.string().optional() }).strict() },
  { name: 'Metric', schema: z.object({...common,...visualFields,label:text,value:dynamic,unit:text.optional(),hint:text.optional()}).strict() },
  { name: 'Progress', schema: z.object({...common,...visualFields,variant:z.enum(['compact','detailed']).optional(),label:text,value:number,min:visualNumber.optional(),max:visualNumber.optional(),marker:visualNumber.optional(),unit:text.optional()}).strict() },
  { name: 'Sparkline', schema: z.object({...common,label:text,values:z.union([z.array(z.number().finite()).max(512),path]),unit:text.optional()}).strict() },
  { name: 'NumberField', schema: z.object({...common,label:text,value:number,min:number.optional(),max:number.optional(),step:number.optional(),unit:text.optional()}).strict() },
  { name: 'Slider', schema: z.object({...common,label:text,value:number,min:number,max:number,step:number.optional(),unit:text.optional()}).strict() },
  { name: 'Link', schema: z.object({...common,label:text,url:text}).strict() },
  { name: 'TextField', schema: base(TextFieldApi.schema)
    .omit({ checks: true, isValid: true, validationErrors: true, validationRegexp: true })
    .extend({ label: text, value: text,checks:uiCommon.checks }) },
  { name: 'CheckBox', schema: base(CheckBoxApi.schema)
    .omit({ checks: true, isValid: true, validationErrors: true })
    .extend({ label: text, value: boolean,checks:uiCommon.checks }) },
  { name: 'ChoicePicker', schema: base(ChoicePickerApi.schema)
    .omit({ checks: true, isValid: true, validationErrors: true, filterable: true, displayStyle: true })
    .extend({
      label: text.optional(),
      value: strings,
      options: z.array(z.object({ label: text, value: z.string() }).strict()),
      checks:uiCommon.checks,
    }) },
  { name: 'Button', schema: z.object({
    ...common,
    child: componentId(),
    variant: z.enum(['default', 'primary', 'borderless', 'danger']).optional(),
    confirm: text.optional(),
    validateForm:z.boolean().optional(),
    action,
  }).strict() },
  { name: 'Status', schema: z.object({ ...common, checkId: z.string().min(1), variant:z.enum(['compact','detailed']).optional() }).strict() },
  { name: 'RunReceipt', schema: z.object({ ...common, actionId:z.string().min(1).optional(), actionIds:z.array(z.string().min(1)).min(1).max(32).optional(), empty:z.enum(['hidden','label']).optional() }).strict() },
]
apis.push(...extensionApis(installedExtensions,apis.map(a=>a.name)))

const componentEnvelope = z.object({ id: z.string().min(1), component: z.string().min(1) }).passthrough()
const surfaceSchema = z.object({
  id: z.string().min(1),
  appId: z.string().min(1),
  order: z.number().finite(),
  formInitial: z.record(z.unknown()),
  components: z.array(componentEnvelope).min(1).max(512),
}).strict()
const uiSchema = z.object({
  previewScenarios:previewScenariosSchema.optional(),
  a2uiVersion: z.literal('0.9.1'),
  catalogId: z.literal(APP_CATALOG_ID),
  surfaces: z.array(surfaceSchema).max(64),
}).strict()

/**
 * Return the schema-only APIs used by both admission and the renderer.
 * @returns catalog entries without framework imports or executable functions.
 */
export function catalogApis(): ComponentApi[] {
  return [...apis,...extensionApis(dynamicPackages(),apis.map(a=>a.name))]
}

/**
 * Create a catalog with no client function execution or global styles.
 * @returns the DSH catalog consumed by the official A2UI processor and resolver.
 */
export function createAppCatalog(): Catalog<ComponentApi> {
  return new Catalog(APP_CATALOG_ID, catalogApis(), uiFunctions)
}

/**
 * Reject unsupported UI fields, unsafe writes, unresolved references, and cycles.
 * @param declaration - declaration whose execution and JSON fields the Host parser validates.
 * @throws when the UI cannot be rendered safely in the DSH catalog.
 */
export function validateUi(declaration: CardDeclaration): void {
  for(const scenario of declaration.ui.previewScenarios??[])previewSnapshot(declaration,scenario)
  const apis=catalogApis()
  const ui = uiSchema.parse(declaration.ui)
  const surfaceIds = new Set<string>()
  for (const surface of ui.surfaces) {
    if (surfaceIds.has(surface.id)) throw new Error(`Duplicate surface: ${surface.id}`)
    surfaceIds.add(surface.id)
    if (!Object.hasOwn(declaration.apps, surface.appId)) throw new Error(`Unknown app: ${surface.appId}`)
    const references = new Map<string, string[]>()
    for (const entry of surface.components) {
      if (references.has(entry.id)) throw new Error(`Duplicate component: ${entry.id}`)
      const api = apis.find(candidate => candidate.name === entry.component)
      if (!api) throw new Error(`Unknown component: ${entry.component}`)
      const { id, component, ...properties } = entry
      const parsed: unknown = api.schema.parse(properties)
      const props = z.record(z.unknown()).parse(parsed)
      validateUiExpressions(properties)
      for(const [lo,hi] of [['min','max'],['colorMin','colorMax']]){
        if(typeof props[lo]==='number'&&typeof props[hi]==='number'&&props[hi]<=props[lo])throw Error(`Component ${id} requires ${hi} > ${lo}`)
      }
      const refs: string[] = []
      for (const [key, ref] of extractRefFields(api.schema)) {
        const value: unknown = props[key]
        if(value===undefined)continue
        if (ref.kind === 'single') refs.push(z.string().parse(value))
        else if (ref.kind === 'list') {
          if (Array.isArray(value)) refs.push(...z.array(z.string()).parse(value))
          else {
            const template = z.object({ componentId: z.string(), path: z.string() }).strict().parse(value)
            if (!validPath(template.path)) throw new Error(`Invalid list path: ${template.path}`)
            refs.push(template.componentId)
          }
        } else {
          for (const item of z.array(z.record(z.unknown())).parse(value)) {
            for (const child of ref.keys) refs.push(z.string().parse(item[child]))
          }
        }
      }
      references.set(id, refs)
      if (['TextField','CheckBox','ChoicePicker','Slider','NumberField'].includes(component)) {
        const value = props['value']
        if (typeof value === 'object' && value !== null && !Array.isArray(value)&&!('call' in value)) {
          const binding = path.parse(value)
          if (!/^\/(?:form|local)(?:\/|$)/u.test(binding.path)) {
            throw new Error(`Input ${id} may write only /form or /local`)
          }
        }
      }
      if((component==='Slider'||component==='NumberField') && typeof props['min']==='number' && typeof props['max']==='number' && props['max']<=props['min']) throw new Error(`Input ${id} requires max > min`)
      if (component === 'Button') {
        const event = action.parse(props['action']).event
        if (declaration.actions[event.context.actionId]?.appId !== surface.appId) {
          throw new Error(`Unknown action for app ${surface.appId}: ${event.context.actionId}`)
        }
      }
      if (component === 'Status' && declaration.checks[String(props['checkId'])]?.appId !== surface.appId) {
        throw new Error(`Unknown check for app ${surface.appId}: ${String(props['checkId'])}`)
      }
      if (component === 'RunReceipt' && (!(!!props['actionId'] !== !!props['actionIds']) || (props['actionIds'] as string[]??[String(props['actionId'])]).some(id=>declaration.actions[id]?.appId!==surface.appId))) {
        throw new Error(`Unknown receipt action: ${String(props['actionId'])}`)
      }
    }
    if (!references.has('root')) throw new Error(`Surface ${surface.id} requires component root`)
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const visit = (id: string, depth: number): void => {
      if (visiting.has(id)) throw new Error(`Cyclic component reference: ${id}`)
      if (depth > 64) throw new Error(`Component nesting exceeds 64: ${id}`)
      if (visited.has(id)) return
      const refs = references.get(id)
      if (!refs) throw new Error(`Unknown component reference: ${id}`)
      visiting.add(id)
      for (const child of refs) visit(child, depth + 1)
      visiting.delete(id)
      visited.add(id)
    }
    for (const id of references.keys()) visit(id, 0)
  }
}

/**
 * Validate JSON produced by a binding before sending an action over Remote.
 * @param value - resolved action context from A2UI.
 * @returns JSON value, excluding non-finite numbers and executable values.
 */
export function parseUiJson(value: unknown): JsonValue {
  const json: z.ZodType<JsonValue> = z.lazy(() => z.union([
    z.null(), z.string(), z.number().finite(), z.boolean(), z.array(json), z.record(json),
  ]))
  return json.parse(value)
}

function validPath(value: string): boolean {
  return value !== '' && value.split('/').every(part =>
    !/^(?:\.{1,2}|__proto__|prototype|constructor)$/u.test(part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    && !/~(?![01])/u.test(part))
}
