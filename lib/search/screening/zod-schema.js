// Minimal, explicit JSON-Schema → Zod translation for the shared screening
// contracts. Hosts translate the SAME definitions instead of re-declaring them,
// so MCP and the private persistence layer cannot drift from the shared schema.
// Only the constructs the shared schemas actually use are supported; anything
// else throws instead of silently weakening validation.
import * as z from 'zod'

function literalUnion(values) {
  const options = values.map((value) => z.literal(value))
  return options.length === 1 ? options[0] : z.union(options)
}

function applyBounds(schema, value) {
  let out = value
  if (schema.minimum !== undefined) out = out.min(schema.minimum)
  if (schema.maximum !== undefined) out = out.max(schema.maximum)
  return out
}

function scalar(type, schema) {
  if (type === 'string') {
    let out = z.string()
    if (schema.minLength !== undefined) out = out.min(schema.minLength)
    if (schema.maxLength !== undefined) out = out.max(schema.maxLength)
    if (schema.pattern !== undefined) out = out.regex(new RegExp(schema.pattern))
    return out
  }
  if (type === 'number') return applyBounds(schema, z.number())
  if (type === 'integer') return applyBounds(schema, z.number()).int()
  if (type === 'boolean') return z.boolean()
  if (type === 'null') return z.null()
  return null
}

/**
 * @param {any} schema JSON Schema (single type, nullable type array, enum, oneOf/anyOf, object, array)
 * @param {{ strict?: boolean }} [options] `strict: false` keeps Zod's default
 *   strip-unknown-keys behaviour for readers that scrub stored files instead of
 *   refusing them; host contracts keep the default strict rejection.
 */
export function jsonSchemaToZod(schema, { strict = true } = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new TypeError('Unsupported screening JSON schema')
  if (Array.isArray(schema.enum)) {
    const value = literalUnion(schema.enum)
    return schema.description ? value.describe(schema.description) : value
  }
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    const branches = schema.oneOf ?? schema.anyOf
    const value = z.union(branches.map((branch) => jsonSchemaToZod(branch, { strict })))
    return schema.description ? value.describe(schema.description) : value
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (!types.length) throw new TypeError('Unsupported screening JSON schema: missing type')
  const nullable = types.includes('null')
  const concrete = types.filter((type) => type !== 'null')
  let value
  if (concrete.length === 0) {
    value = z.null()
  } else if (concrete.length === 1 && concrete[0] === 'object') {
    const shape = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => {
      const childSchema = jsonSchemaToZod(child, { strict })
      return [key, (schema.required ?? []).includes(key) ? childSchema : childSchema.optional()]
    }))
    let object = z.object(shape)
    if (schema.additionalProperties === true) object = object.passthrough()
    else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') object = object.catchall(jsonSchemaToZod(schema.additionalProperties, { strict }))
    else if (strict) object = object.strict()
    value = object
  } else if (concrete.length === 1 && concrete[0] === 'array') {
    let out = z.array(jsonSchemaToZod(schema.items, { strict }))
    if (schema.minItems !== undefined) out = out.min(schema.minItems)
    if (schema.maxItems !== undefined) out = out.max(schema.maxItems)
    value = out
  } else if (concrete.length === 1) {
    value = scalar(concrete[0], schema)
    if (!value) throw new TypeError(`Unsupported screening JSON schema type: ${concrete[0]}`)
  } else {
    const options = concrete.map((type) => scalar(type, schema))
    if (options.some((option) => !option)) throw new TypeError('Unsupported screening JSON schema type array')
    value = z.union(options)
  }
  if (nullable) value = value.nullable()
  if (schema.description) value = value.describe(schema.description)
  return value
}

const objectSchema = (schema) => schema && typeof schema === 'object' && !Array.isArray(schema) && (
  schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))
)

/**
 * Flatten a top-level `oneOf`/`anyOf` of object branches into one strict object
 * shape for hosts that validate a single returned object (the MCP SDK rejects a
 * union as an output schema). Branch-specific properties stay optional and the
 * intersection of the branches stays required; a property that two branches
 * declare differently keeps both alternatives. The exact-one union itself is
 * still enforced by the shared schema, the private persistence readers and the
 * DSH Ajv output check.
 */
export function projectObjectUnion(schema) {
  const branches = schema.oneOf ?? schema.anyOf
  if (!Array.isArray(branches)) return schema
  if (!branches.every(objectSchema)) throw new TypeError('Unsupported screening union: every branch must be an object')
  const properties = {}
  for (const branch of branches) {
    for (const [key, child] of Object.entries(branch.properties ?? {})) {
      if (!Object.hasOwn(properties, key)) properties[key] = child
      else if (JSON.stringify(properties[key]) !== JSON.stringify(child)) properties[key] = { oneOf: [properties[key], child] }
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    description: schema.description,
    properties,
    required: (branches[0].required ?? []).filter((key) => branches.every((branch) => (branch.required ?? []).includes(key))),
  }
}
