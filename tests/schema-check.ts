/**
 * A small JSON Schema reader for the schema files this repository holds
 * (docs/control-center/engine-report.schema.json and docs/packet.schema.json),
 * so the tests check against the files themselves rather than against the
 * validators they are testing. It covers every keyword those files use:
 * $ref into $defs, const, enum, type, oneOf, anyOf, allOf, not, minLength,
 * maxLength, pattern, format date-time, minimum, maximum, exclusiveMinimum,
 * minItems, maxItems, uniqueItems, items, required, properties,
 * additionalProperties, propertyNames and maxProperties. Every object that
 * lists `properties` is treated as closed unless additionalProperties gives a
 * schema, because the server refuses a field it does not know.
 */
type Schema = Record<string, unknown>

/** Resolves a local reference (#/$defs/name, or any #/a/b path) against the root schema. */
function resolve(root: Schema, ref: string): Schema {
  if (!ref.startsWith('#/')) throw new Error(`schema-check: only local refs, got ${ref}`)
  let cur: unknown = root
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined
  }
  if (!cur || typeof cur !== 'object') throw new Error(`schema-check: unresolved ref ${ref}`)
  return cur as Schema
}

const typeOf = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value)

export function schemaErrors(schema: Schema, value: unknown, path = '$', root: Schema = schema): string[] {
  const errs: string[] = []
  if (typeof schema.$ref === 'string') errs.push(...schemaErrors(resolve(root, schema.$ref), value, path, root))
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) errs.push(`${path}: const`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errs.push(`${path}: enum`)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = typeOf(value)
    const ok = types.some(t => t === actual || (t === 'number' && actual === 'integer'))
    if (!ok) { errs.push(`${path}: type ${actual} not ${types.join('|')}`); return errs }
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter(s => schemaErrors(s as Schema, value, path, root).length === 0).length
    if (passing !== 1) errs.push(`${path}: oneOf matched ${passing}`)
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(s => schemaErrors(s as Schema, value, path, root).length === 0)) errs.push(`${path}: anyOf`)
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) errs.push(...schemaErrors(s as Schema, value, path, root))
  if (schema.not && typeof schema.not === 'object' && schemaErrors(schema.not as Schema, value, path, root).length === 0) errs.push(`${path}: not`)
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errs.push(`${path}: minLength`)
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errs.push(`${path}: maxLength`)
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errs.push(`${path}: pattern`)
    if (schema.format === 'date-time' && (Number.isNaN(Date.parse(value)) || !value.includes('T'))) errs.push(`${path}: date-time`)
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${path}: minimum`)
    if (typeof schema.maximum === 'number' && value > schema.maximum) errs.push(`${path}: maximum`)
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errs.push(`${path}: exclusiveMinimum`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${path}: minItems`)
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${path}: maxItems`)
    if (schema.uniqueItems === true && new Set(value.map(v => JSON.stringify(v))).size !== value.length) errs.push(`${path}: uniqueItems`)
    if (schema.items) value.forEach((v, i) => errs.push(...schemaErrors(schema.items as Schema, v, `${path}[${i}]`, root)))
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Schema>
    const extra = schema.additionalProperties
    const keys = Object.keys(value)
    for (const k of (schema.required ?? []) as string[]) if (!(k in value)) errs.push(`${path}.${k}: required`)
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) errs.push(`${path}: maxProperties`)
    if (schema.propertyNames && typeof schema.propertyNames === 'object') for (const k of keys) errs.push(...schemaErrors(schema.propertyNames as Schema, k, `${path}.${k}<name>`, root))
    for (const [k, v] of Object.entries(value)) {
      if (k in props) { errs.push(...schemaErrors(props[k], v, `${path}.${k}`, root)); continue }
      if (extra && typeof extra === 'object') { errs.push(...schemaErrors(extra as Schema, v, `${path}.${k}`, root)); continue }
      if (schema.properties || extra === false) errs.push(`${path}.${k}: unknown field`)
    }
  }
  return errs
}
