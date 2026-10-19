/**
 * A small JSON Schema reader for the protocol's own schema file, so the report
 * tests check against docs/control-center/engine-report.schema.json itself
 * rather than against the validator they are testing. It covers the keywords
 * that file uses, and it treats every object that lists `properties` as
 * closed, because the server refuses a field it does not know.
 */
type Schema = Record<string, unknown>

export function schemaErrors(schema: Schema, value: unknown, path = '$'): string[] {
  const errs: string[] = []
  if ('const' in schema && value !== schema.const) errs.push(`${path}: const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(`${path}: enum`)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value
    const ok = types.some(t => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) { errs.push(`${path}: type ${actual} not ${types.join('|')}`); return errs }
  }
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errs.push(`${path}: maxLength`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: pattern`)
    if (schema.format === 'date-time' && (Number.isNaN(Date.parse(value)) || !value.includes('T'))) errs.push(`${path}: date-time`)
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${path}: minimum`)
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${path}: maxItems`)
    if (schema.items) value.forEach((v, i) => errs.push(...schemaErrors(schema.items as Schema, v, `${path}[${i}]`)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) errs.push(`${path}.${k}: required`)
    for (const [k, v] of Object.entries(value)) {
      if (!(k in props)) { if (schema.properties) errs.push(`${path}.${k}: unknown field`); continue }
      errs.push(...schemaErrors(props[k], v, `${path}.${k}`))
    }
  }
  return errs
}
